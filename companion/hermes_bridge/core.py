"""Durable single-worker jobs; no Hermes imports or process-global cwd changes."""

from __future__ import annotations

import base64
import binascii
import fcntl
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID


@dataclass(frozen=True)
class Limits:
    body: int = 32 * 1024 * 1024
    text: int = 64 * 1024
    files: int = 8
    file_bytes: int = 10 * 1024 * 1024
    total_bytes: int = 20 * 1024 * 1024


class BridgeError(Exception):
    """Only fixed, credential-free messages may cross the HTTP boundary."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def wire_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def fail_size() -> None:
    raise BridgeError("payload_too_large", "Payload exceeds configured limits.", 413)


def uuid_string(value: Any) -> str:
    if not isinstance(value, str):
        raise BridgeError("invalid_request", "A UUID string is required.")
    try:
        return str(UUID(value))
    except (ValueError, AttributeError):
        raise BridgeError("invalid_request", "A UUID string is required.") from None


def utf8_size(value: Any) -> int:
    if not isinstance(value, str):
        raise BridgeError("invalid_request", "Text must be a UTF-8 string.")
    try:
        return len(value.encode("utf-8"))
    except UnicodeError:
        raise BridgeError("invalid_request", "Text must be a UTF-8 string.") from None


def valid_name(name: Any) -> bool:
    return (isinstance(name, str) and bool(name) and name not in (".", "..")
            and not any(c in name for c in ("/", "\\", "\x00"))
            and not any(ord(c) < 32 or ord(c) == 127 for c in name)
            and not re.match(r"^[A-Za-z]:", name))


MIME = re.compile(r"^[A-Za-z0-9!#$&^_.+\-]+/[A-Za-z0-9!#$&^_.+\-]+$")
IMAGE_MIMES = frozenset(("image/png", "image/jpeg", "image/gif", "image/webp"))
BACKEND_VERSION = "gateway-v1-runs/1"


def normalize_job(value: Any, limits: Limits) -> dict[str, Any]:
    required = {"id", "threadId", "text", "attachments"}
    if not isinstance(value, dict) or set(value) not in (required, required | {"input_assets"}):
        raise BridgeError("invalid_request", "Expected id, threadId, text, and attachments.")
    job_id, thread_id = uuid_string(value["id"]), uuid_string(value["threadId"])
    if utf8_size(value["text"]) > limits.text:
        fail_size()
    files = value["attachments"]
    if not isinstance(files, list):
        raise BridgeError("invalid_request", "Attachments must be an array.")
    if len(files) > limits.files:
        fail_size()
    names: set[str] = set()
    normalized = []
    total = 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {"name", "mime", "base64"}:
            raise BridgeError("invalid_attachment", "Invalid attachment fields.")
        name, mime, encoded = item["name"], item["mime"], item["base64"]
        if not valid_name(name) or name in names:
            raise BridgeError("invalid_attachment", "Attachment names must be unique safe filenames.")
        if utf8_size(name) > 255:
            raise BridgeError("invalid_attachment", "Attachment filename is too long.")
        names.add(name)
        if not isinstance(mime, str) or len(mime) > 255 or not MIME.fullmatch(mime):
            raise BridgeError("invalid_attachment", "Invalid MIME type.")
        if mime.lower() not in IMAGE_MIMES:
            raise BridgeError("unsupported_attachment", "Only PNG, JPEG, GIF, and WebP images are supported.", 415)
        if not isinstance(encoded, str):
            raise BridgeError("invalid_attachment", "Attachment base64 must be a string.")
        if len(encoded) > 4 * ((limits.file_bytes + 2) // 3):
            fail_size()
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise BridgeError("invalid_attachment", "Invalid canonical base64.") from None
        canonical = base64.b64encode(data).decode("ascii")
        if canonical != encoded:
            raise BridgeError("invalid_attachment", "Invalid canonical base64.")
        total += len(data)
        if len(data) > limits.file_bytes or total > limits.total_bytes:
            fail_size()
        normalized.append({"name": name, "mime": mime.lower(), "base64": canonical})
    result = {"id": job_id, "threadId": thread_id, "text": value["text"], "attachments": normalized}
    if "input_assets" in value:
        ids = value["input_assets"]
        if not isinstance(ids, list):
            raise BridgeError("invalid_request", "input_assets must be an array of UUIDs.")
        if len(ids) > 8:
            fail_size()
        ids = [uuid_string(item) for item in ids]
        if len(ids) != len(set(ids)):
            raise BridgeError("invalid_request", "input_assets must not contain duplicate UUIDs.")
        result["input_assets"] = ids
    return result


def private_directory(path: Path) -> Path:
    if path.is_symlink():
        raise ValueError("Private directory must not be a symlink.")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path.resolve()


@dataclass(frozen=True)
class GatewayRecord:
    body: bytes
    scope: str
    session_id: str
    first_sent: float
    run_id: str | None


class GatewayCheckpoint(Protocol):
    def prepare(self, body: bytes, scope: str, session_id: str) -> tuple[GatewayRecord, bool]: ...
    def accepted(self, run_id: str) -> None: ...
    def has_output_assets(self) -> bool: ...


class RunPaused(Exception):
    """Local shutdown only: leave the durable remote run untouched."""


def outcome_unknown() -> BridgeError:
    return BridgeError("gateway_outcome_unknown", "Gateway outcome is unknown; this job will not be submitted again.", 502)


@dataclass(frozen=True)
class RunInput:
    job_id: str
    thread_id: str
    text: str
    attachments: tuple[dict[str, str], ...] = ()
    checkpoint: GatewayCheckpoint | None = field(default=None, repr=False, compare=False)
    input_assets: tuple[str, ...] | None = None


@dataclass(frozen=True)
class RunResult:
    final_response: str
    # Retained for the standalone export_result utility, never sent to Gateway.
    messages: list[dict[str, Any]] = field(default_factory=list)
    # Test/local adapters may return inline images; native /v1/runs has no media contract.
    attachments: list[dict[str, str]] = field(default_factory=list)


class Runner(Protocol):
    scope: str
    def run(self, request: RunInput) -> RunResult: ...


def runner_scope(runner: Runner) -> str:
    scope = getattr(runner, "scope", None)
    if not isinstance(scope, str) or not scope:
        raise ValueError("Runner must provide a nonempty, non-secret backend scope.")
    return scope


def read_output(root: Path, raw_path: str, limit: int) -> tuple[str, bytes]:
    """Open every component relative to trusted dirfds, never following symlinks."""
    path = Path(raw_path)
    if not path.is_absolute() or ".." in path.parts or "\x00" in raw_path:
        raise BridgeError("unsafe_output", "MEDIA must name a file inside this job's output directory.")
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        raise BridgeError("unsafe_output", "MEDIA must name a file inside this job's output directory.") from None
    if not parts or not valid_name(parts[-1]):
        raise BridgeError("unsafe_output", "Invalid MEDIA output filename.")
    opened = []
    try:
        current = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened.append(current)
        for part in root.parts[1:]:
            current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            opened.append(current)
        for part in parts[:-1]:
            current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            opened.append(current)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        opened.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise BridgeError("unsafe_output", "MEDIA output must be a regular file.")
        if info.st_size > limit:
            fail_size()
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            fail_size()
        return parts[-1], data
    except OSError:
        raise BridgeError("unsafe_output", "MEDIA output is missing, inaccessible, or unsafe.") from None
    finally:
        for fd in reversed(opened):
            os.close(fd)


def export_result(result: RunResult, output: Path, limits: Limits) -> tuple[str, list[dict[str, str]]]:
    if not isinstance(result, RunResult) or not isinstance(result.final_response, str) or not isinstance(result.messages, list):
        raise BridgeError("invalid_result", "Hermes returned an invalid result.")
    if utf8_size(result.final_response) > limits.body:
        fail_size()
    text_lines, attachments = [], []
    names: set[str] = set()
    total = 0
    for line in result.final_response.splitlines(keepends=True):
        if not line.lstrip().startswith("MEDIA:"):
            text_lines.append(line)
            continue
        if len(attachments) >= limits.files:
            fail_size()
        raw_path = line.lstrip()[len("MEDIA:"):].strip()
        name, data = read_output(output, raw_path, limits.file_bytes)
        if name in names:
            raise BridgeError("invalid_output", "Output attachment names must be unique.")
        names.add(name)
        total += len(data)
        if total > limits.total_bytes:
            fail_size()
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        attachments.append({"name": name, "mime": mime, "base64": base64.b64encode(data).decode("ascii")})
    text = "".join(text_lines).rstrip("\r\n")
    if utf8_size(text) > limits.text:
        fail_size()
    return text, attachments


class _JobCheckpoint:
    """The service's single SQLite connection and lock own all Gateway state."""

    def __init__(self, service: JobService, job_id: str):
        self.service, self.job_id = service, job_id

    def prepare(self, body: bytes, scope: str, session_id: str) -> tuple[GatewayRecord, bool]:
        service = self.service
        with service._condition, service._db:
            if service._stopping:
                raise RunPaused()
            job = service._db.execute("SELECT gateway_scope FROM jobs WHERE id=?", (self.job_id,)).fetchone()
            if job is None or job["gateway_scope"] != scope:
                raise outcome_unknown()
            row = service._db.execute("SELECT * FROM gateway_runs WHERE job_id=?", (self.job_id,)).fetchone()
            fresh = row is None
            if fresh:
                service._db.execute(
                    "INSERT INTO gateway_runs(job_id,body,scope,session_id,first_sent) VALUES(?,?,?,?,?)",
                    (self.job_id, body, scope, session_id, time.time()))
                row = service._db.execute("SELECT * FROM gateway_runs WHERE job_id=?", (self.job_id,)).fetchone()
            record = GatewayRecord(bytes(row["body"]), row["scope"], row["session_id"], row["first_sent"], row["run_id"])
            if (record.body, record.scope, record.session_id) != (body, scope, session_id):
                raise outcome_unknown()
        # The FULL-synchronous transaction commits BEFORE the caller can POST.
        return record, fresh

    def accepted(self, run_id: str) -> None:
        service = self.service
        with service._condition, service._db:
            cursor = service._db.execute(
                "UPDATE gateway_runs SET run_id=? WHERE job_id=? AND run_id IS NULL", (run_id, self.job_id))
            if cursor.rowcount != 1:
                raise outcome_unknown()

    def has_output_assets(self) -> bool:
        with self.service._condition:
            return bool(self.service.assets.output_assets(self.job_id))


class JobService:
    def __init__(self, workspace: str | Path, runner: Runner, *, limits: Limits | None = None,
                 autostart: bool = True, files_enabled: bool = False, asset_ttl: float = 86400):
        scope = runner_scope(runner)
        self.workspace = private_directory(Path(workspace).absolute())
        # One owner per workspace, including across processes. A second server must
        # never mark a live worker's job as interrupted or replay its queue.
        self._lock_fd = os.open(self.workspace / "worker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.fchmod(self._lock_fd, 0o600)
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self._lock_fd)
            raise ValueError("Workspace is already owned by another companion.") from None
        self.jobs_dir = private_directory(self.workspace / "jobs")
        self.limits = limits or Limits()
        self.runner = runner
        self.files_enabled = files_enabled
        self._condition = threading.Condition(threading.RLock())
        self._stopping = False
        self._closed = False
        self._worker: threading.Thread | None = None
        db_path = self.workspace / "bridge.sqlite3"
        fd = os.open(db_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                thread_id TEXT NOT NULL, fingerprint TEXT NOT NULL, input TEXT NOT NULL,
                status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
                attachments TEXT NOT NULL DEFAULT '[]', error TEXT, gateway_scope TEXT
            );
            CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, messages TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS gateway_runs (
                job_id TEXT PRIMARY KEY REFERENCES jobs(id), body BLOB NOT NULL,
                scope TEXT NOT NULL, session_id TEXT NOT NULL, first_sent REAL NOT NULL, run_id TEXT
            );
        """)
        with self._db:
            if "gateway_scope" not in {row["name"] for row in self._db.execute("PRAGMA table_info(jobs)")}:
                self._db.execute("ALTER TABLE jobs ADD COLUMN gateway_scope TEXT")
            if "output_assets" not in {row["name"] for row in self._db.execute("PRAGMA table_info(jobs)")}:
                self._db.execute("ALTER TABLE jobs ADD COLUMN output_assets TEXT")
            version = self._db.execute("SELECT value FROM metadata WHERE key='backend_version'").fetchone()
            if version is None or version["value"] != BACKEND_VERSION:
                self._db.execute("UPDATE jobs SET status='failed',text='',attachments='[]',error=? WHERE status IN ('queued','running')",
                                 (wire_json({"code": "backend_changed", "message": "Backend changed; legacy pending jobs will not be executed."}).decode(),))
                self._db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('backend_version',?)", (BACKEND_VERSION,))
            # A committed send intent without its receipt is never POSTed again.
            error = outcome_unknown()
            self._db.execute("""UPDATE jobs SET status='failed',text='',attachments='[]',error=?
                WHERE status IN ('queued','running') AND id IN
                (SELECT job_id FROM gateway_runs WHERE run_id IS NULL)""",
                (wire_json({"code": error.code, "message": error.message}).decode(),))
            # Older Gateway records can prove their original target. Never bind
            # an unscoped, unsent queue entry to whichever backend starts next.
            self._db.execute("""UPDATE jobs SET gateway_scope=
                (SELECT scope FROM gateway_runs WHERE job_id=jobs.id)
                WHERE gateway_scope IS NULL AND status IN ('queued','running')""")
            self._db.execute("""UPDATE jobs SET status='failed',text='',attachments='[]',error=?
                WHERE status IN ('queued','running') AND (gateway_scope IS NULL OR gateway_scope!=?)""",
                (wire_json({"code": error.code, "message": error.message}).decode(), scope))
        from .assets import AssetStore
        try:
            self.assets = AssetStore(self, asset_ttl)
        except Exception:
            self._db.close()
            os.close(self._lock_fd)
            raise
        if autostart:
            self.start()

    def start(self) -> None:
        with self._condition:
            if self._worker is not None:
                return
            if self._stopping:
                raise RuntimeError("Service is stopping.")
            self._worker = threading.Thread(target=self._work, name="hermes-job-worker", daemon=True)
            self._worker.start()

    def submit(self, value: Any) -> str:
        job = normalize_job(value, self.limits)
        encoded = wire_json(job)
        if len(encoded) > self.limits.body:
            fail_size()
        content = {k: v for k, v in job.items() if k != "id"}
        fingerprint = hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=True,
                                                separators=(",", ":")).encode()).hexdigest()
        with self._condition:
            row = self._db.execute("SELECT fingerprint FROM jobs WHERE id=?", (job["id"],)).fetchone()
            if row is not None:
                if row["fingerprint"] != fingerprint:
                    raise BridgeError("id_conflict", "Job ID already belongs to different content.", 409)
                return job["id"]
            with self._db:
                if "input_assets" in job:
                    self.assets.freeze_inputs(job)
                self._db.execute("INSERT INTO jobs(id,thread_id,fingerprint,input,status,gateway_scope) VALUES(?,?,?,?, 'queued',?)",
                                 (job["id"], job["threadId"], fingerprint, encoded.decode(), runner_scope(self.runner)))
            self._condition.notify_all()
        return job["id"]

    def get(self, job_id: str) -> dict[str, Any]:
        job_id = uuid_string(job_id)
        with self._condition:
            row = self._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise BridgeError("not_found", "Job not found.", 404)
        result = {"id": row["id"], "status": row["status"], "text": row["text"],
                "attachments": json.loads(row["attachments"]),
                "error": json.loads(row["error"]) if row["error"] else None}
        if "input_assets" in json.loads(row["input"]):
            result["output_assets"] = json.loads(row["output_assets"] or "[]") if row["status"] == "completed" else []
        return result

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._stopping = True
            self._condition.notify_all()
        stop = getattr(self.runner, "stop", None)
        if stop is not None:
            stop()
        if self._worker is not None:
            self._worker.join()
        with self._condition:
            self.assets.close()
            self._db.close()
            os.close(self._lock_fd)
            self._closed = True

    def _request(self, job: dict[str, Any]) -> RunInput:
        # Gateway receives inline data, not bridge-local paths or legacy history.
        return RunInput(job["id"], job["threadId"], job["text"], tuple(job["attachments"]),
                        _JobCheckpoint(self, job["id"]), tuple(job["input_assets"]) if "input_assets" in job else None)

    def _work(self) -> None:
        while True:
            with self._condition:
                if self._stopping:
                    return
                row = self._db.execute("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY seq LIMIT 1").fetchone()
                if row is None:
                    self._condition.wait()
                    continue
                with self._db:
                    self._db.execute("UPDATE jobs SET status='running' WHERE id=?", (row["id"],))
            try:
                output_started = False
                if row["gateway_scope"] is None or row["gateway_scope"] != getattr(self.runner, "scope", None):
                    raise outcome_unknown()
                request = self._request(json.loads(row["input"]))
                if request.input_assets is not None and not self.files_enabled:
                    raise BridgeError("assets_disabled", "File transfer is not configured.", 415)
                result = self.runner.run(request)
                output_started = True
                if not isinstance(result, RunResult):
                    raise BridgeError("invalid_result", "Gateway returned an invalid result.")
                text = result.final_response
                if utf8_size(text) > self.limits.text:
                    fail_size()
                attachments = normalize_job({"id": request.job_id, "threadId": request.thread_id,
                                             "text": "", "attachments": result.attachments}, self.limits)["attachments"]
                with self._condition, self._db:
                    outputs = self.assets.output_assets(row["id"]) if request.input_assets is not None else []
                    if re.search(r"\bMEDIA:", text, re.IGNORECASE) and not outputs:
                        raise BridgeError("unsupported_output", "Gateway file output is not supported.", 502)
                    if (len(outputs) + len(attachments) > 8 or sum(item["size"] for item in outputs)
                            + sum(len(base64.b64decode(item["base64"])) for item in attachments) > 20 * 1024 * 1024):
                        fail_size()
                    response = {"id": row["id"], "status": "completed", "text": text,
                                "attachments": attachments, "error": None}
                    if request.input_assets is not None:
                        response["output_assets"] = outputs
                    if len(wire_json(response)) > self.limits.body:
                        fail_size()
                    # Same lock/transaction as asset publication: late publishers
                    # cannot join the result after this terminal freeze.
                    self._db.execute("UPDATE jobs SET status='completed',text=?,attachments=?,output_assets=?,error=NULL WHERE id=?",
                                     (text, wire_json(attachments).decode(), wire_json(outputs).decode(), row["id"]))
            except RunPaused:
                # Preserve running + checkpoint for GET-only recovery; no remote stop.
                return
            except Exception as exc:
                # Never return/log raw exception text: provider exceptions often contain secrets.
                error = ({"code": "output_too_large", "message": "Job output exceeds configured limits."}
                         if isinstance(exc, BridgeError) and exc.status == 413 and output_started else
                         {"code": exc.code, "message": exc.message} if isinstance(exc, BridgeError) else
                          {"code": "execution_failed", "message": "Gateway execution failed; check the private runtime configuration."})
                with self._condition, self._db:
                    self._db.execute("UPDATE jobs SET status='failed',text='',attachments='[]',error=? WHERE id=?",
                                     (wire_json(error).decode(), row["id"]))
