"""Opaque job-bound bytes, using the job service's SQLite connection and lock.

No archive parsing, model calls, profile paths, or credential persistence. Expiry
retains metadata tombstones; it never deletes the jobs/Gateway ledgers.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import time
from typing import Any, BinaryIO
from uuid import uuid4

from .core import BridgeError, MIME, fail_size, runner_scope, utf8_size, uuid_string, valid_name

MAX_ASSET_BYTES = 10 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 20 * 1024 * 1024
MAX_ASSETS = 8
FIELDS = ("asset_id", "name", "mime", "size", "sha256")


def conflict() -> BridgeError:
    return BridgeError("asset_conflict", "Asset identity or job state conflicts with this operation.", 409)


def unavailable() -> BridgeError:
    return BridgeError("asset_unavailable", "Asset bytes are expired, missing, or unsafe.", 410)


def metadata(asset_id: str, name: str, mime: str, size: int, digest: str) -> dict[str, Any]:
    if not valid_name(name) or utf8_size(name) > 255:
        raise BridgeError("invalid_asset", "Asset filename must be a safe basename.")
    if not isinstance(mime, str) or len(mime) > 255 or not MIME.fullmatch(mime):
        raise BridgeError("invalid_asset", "Asset MIME must be a bare MIME type.")
    if type(size) is not int or size < 0:
        raise BridgeError("invalid_asset", "Asset length must be a nonnegative integer.")
    if size > MAX_ASSET_BYTES:
        fail_size()
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise BridgeError("invalid_asset", "Asset SHA-256 must be lowercase hexadecimal.")
    return dict(zip(FIELDS, (uuid_string(asset_id), name, mime.lower(), size, digest)))


class AssetStore:
    def __init__(self, service, ttl: float = 86400):
        if not math.isfinite(ttl) or ttl <= 0:
            raise ValueError("Asset TTL must be positive and finite.")
        self.service, self.ttl = service, ttl
        parent = os.open(service.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.mkdir("artifacts", mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
            self.fd = os.open("artifacts", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(parent)
        info = os.fstat(self.fd)
        if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (os.getuid(), os.getgid(), 0o700):
            os.close(self.fd)
            raise ValueError("Artifact directory must be private and owned by this service.")
        service._db.execute("""CREATE TABLE IF NOT EXISTS assets (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT UNIQUE NOT NULL,
            job_id TEXT NOT NULL, direction TEXT NOT NULL, run_id TEXT, scope TEXT NOT NULL,
            name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
            state TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL)""")
        service._db.commit()
        # The workspace lock excludes another publisher. Uncommitted seals and
        # temporary files from an interrupted transfer are never made visible.
        for name in os.listdir(self.fd):
            if re.fullmatch(r"tmp-[0-9a-f]{32}", name):
                os.unlink(name, dir_fd=self.fd)
        for row in service._db.execute("SELECT asset_id FROM assets WHERE state!='sealed'"):
            self._unlink(row["asset_id"])
        self.expire()

    def close(self) -> None:
        os.close(self.fd)

    def _enabled(self) -> None:
        if self.service._stopping:
            raise BridgeError("service_stopping", "Companion is stopping.", 409)
        if not self.service.files_enabled:
            raise BridgeError("assets_disabled", "File transfer is not configured.", 415)

    def _unlink(self, asset_id: str) -> None:
        try:
            os.unlink(uuid_string(asset_id) + ".blob", dir_fd=self.fd)
        except FileNotFoundError:
            pass

    @staticmethod
    def descriptor(row) -> dict[str, Any]:
        return {key: row[key] for key in FIELDS}

    def _job(self, job_id: str):
        return self.service._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()

    def _scope(self, row) -> None:
        if row is not None and row["gateway_scope"] != runner_scope(self.service.runner):
            raise conflict()

    def _run(self, run_id: str):
        self._enabled()
        if not isinstance(run_id, str) or re.fullmatch(r"run_[0-9a-f]{32}", run_id) is None:
            raise BridgeError("not_found", "Run mapping not found.", 404)
        mappings = self.service._db.execute("SELECT job_id,scope FROM gateway_runs WHERE run_id=?", (run_id,)).fetchall()
        if len(mappings) != 1:
            raise BridgeError("not_found", "Run mapping not found.", 404)
        job = self._job(mappings[0]["job_id"])
        if (job is None or job["status"] != "running" or mappings[0]["scope"] != runner_scope(self.service.runner)
                or "input_assets" not in json.loads(job["input"])):
            raise conflict()
        self._scope(job)
        return job

    def _row(self, asset_id: str):
        row = self.service._db.execute("SELECT * FROM assets WHERE asset_id=?", (asset_id,)).fetchone()
        if row is not None and (row["state"] == "expired" or row["expires"] <= time.time()):
            raise unavailable()
        return row

    def _authorize_put(self, job_id: str, asset_id: str, run_id: str | None):
        self._enabled()
        job = self._run(run_id) if run_id else self._job(job_id)
        if run_id and job["id"] != job_id:
            raise conflict()
        self._scope(job)
        row = self._row(asset_id)
        if not run_id and job is not None:
            ids = json.loads(job["input"]).get("input_assets", [])
            # After submission only an exact retry of a frozen sealed input is legal.
            if asset_id not in ids or row is None or row["state"] != "sealed":
                raise conflict()
        return row

    def put(self, job_id: str, asset: dict[str, Any], stream: BinaryIO, *, run_id: str | None = None):
        job_id = uuid_string(job_id)
        asset = metadata(**{"asset_id": asset["asset_id"], "name": asset["name"], "mime": asset["mime"],
                            "size": asset["size"], "digest": asset["sha256"]})
        direction = "output" if run_id else "input"
        service = self.service
        with service._condition, service._db:
            row = self._authorize_put(job_id, asset["asset_id"], run_id)
            if row is not None:
                if (row["job_id"], row["direction"], row["run_id"], row["scope"], self.descriptor(row)) != (
                        job_id, direction, run_id, runner_scope(service.runner), asset):
                    raise conflict()
            else:
                used = service._db.execute("SELECT COUNT(*),COALESCE(SUM(size),0) FROM assets WHERE job_id=? AND direction=?",
                                           (job_id, direction)).fetchone()
                if used[0] >= MAX_ASSETS or used[1] + asset["size"] > MAX_TOTAL_ASSET_BYTES:
                    fail_size()
                now = time.time()
                service._db.execute("""INSERT INTO assets(asset_id,job_id,direction,run_id,scope,name,mime,size,sha256,state,created,expires)
                    VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?)""", (asset["asset_id"], job_id, direction, run_id,
                    runner_scope(service.runner), asset["name"], asset["mime"], asset["size"], asset["sha256"], now, now + self.ttl))
            directory = os.dup(self.fd)
        temp = "tmp-" + uuid4().hex
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            os.fchmod(fd, 0o600)
            digest = hashlib.sha256()
            remaining = asset["size"]
            with os.fdopen(fd, "wb") as target:
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk or len(chunk) > remaining:
                        raise BridgeError("invalid_length", "Asset body is incomplete or invalid.")
                    target.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                target.flush()
                os.fsync(target.fileno())
            if digest.hexdigest() != asset["sha256"]:
                raise BridgeError("asset_hash_mismatch", "Asset bytes do not match their SHA-256.")
            with service._condition, service._db:
                row = self._authorize_put(job_id, asset["asset_id"], run_id)
                if row["state"] == "sealed":
                    self._read(row)  # Do not acknowledge missing/tampered existing bytes.
                    return 200, asset
                try:
                    os.link(temp, asset["asset_id"] + ".blob", src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                except FileExistsError:
                    raise conflict() from None
                os.unlink(temp, dir_fd=directory)
                os.fsync(directory)
                service._db.execute("UPDATE assets SET state='sealed' WHERE asset_id=?", (asset["asset_id"],))
            return 201, asset
        finally:
            try:
                os.unlink(temp, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.close(directory)

    def _read(self, row) -> bytes:
        if row["state"] != "sealed":
            raise BridgeError("asset_not_ready", "Asset is not sealed.", 409)
        try:
            fd = os.open(uuid_string(row["asset_id"]) + ".blob", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != row["size"]
                        or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (os.getuid(), os.getgid(), 0o600)):
                    raise unavailable()
                data = source.read(MAX_ASSET_BYTES + 1)
        except OSError:
            raise unavailable() from None
        if len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise unavailable()
        return data

    def freeze_inputs(self, job: dict[str, Any]) -> None:
        """Caller holds the same lock/transaction as INSERT jobs."""
        self._enabled()
        rows = []
        for asset_id in job["input_assets"]:
            row = self._row(asset_id)
            if (row is None or row["job_id"] != job["id"] or row["direction"] != "input"
                    or row["state"] != "sealed" or row["scope"] != runner_scope(self.service.runner)):
                raise conflict()
            self._read(row)
            rows.append(row)
        import base64
        inline_bytes = sum(len(base64.b64decode(item["base64"])) for item in job["attachments"])
        if len(rows) + len(job["attachments"]) > MAX_ASSETS or sum(row["size"] for row in rows) + inline_bytes > MAX_TOTAL_ASSET_BYTES:
            fail_size()

    def output_assets(self, job_id: str) -> list[dict[str, Any]]:
        """Caller holds the completion lock: only sealed outputs enter the frozen result."""
        rows = self.service._db.execute("SELECT * FROM assets WHERE job_id=? AND direction='output' AND state='sealed' ORDER BY seq",
                                        (job_id,)).fetchall()
        for row in rows:
            if row["expires"] <= time.time():
                raise unavailable()
            self._read(row)
        return [self.descriptor(row) for row in rows]

    def list_inputs(self, run_id: str) -> dict[str, Any]:
        with self.service._condition:
            job = self._run(run_id)
            assets = []
            for asset_id in json.loads(job["input"])["input_assets"]:
                row = self._row(asset_id)
                if row is None or row["state"] != "sealed":
                    raise unavailable()
                assets.append(self.descriptor(row))
            return {"job_id": job["id"], "input_assets": assets}

    def put_output(self, run_id: str, asset, stream):
        with self.service._condition:
            job_id = self._run(run_id)["id"]
        return self.put(job_id, asset, stream, run_id=run_id)

    def get(self, job_id: str | None, asset_id: str, *, run_id: str | None = None):
        asset_id = uuid_string(asset_id)
        with self.service._condition:
            self._enabled()
            job = self._run(run_id) if run_id else self._job(uuid_string(job_id))
            job_id = job["id"] if run_id else uuid_string(job_id)
            self._scope(job)
            row = self._row(asset_id)
            if row is None or row["job_id"] != job_id:
                raise BridgeError("not_found", "Asset not found for this job.", 404)
            if row["scope"] != runner_scope(self.service.runner):
                raise conflict()
            if run_id:
                if row["direction"] != "input" or asset_id not in json.loads(job["input"])["input_assets"]:
                    raise conflict()
            elif row["direction"] == "output":
                if job is None or job["status"] != "completed" or asset_id not in [item["asset_id"] for item in json.loads(job["output_assets"] or "[]")]:
                    raise conflict()
            return self.descriptor(row), self._read(row)

    def expire(self, now: float | None = None) -> int:
        """Explicit, bounded-by-stored-records cleanup; IDs remain permanent tombstones."""
        now = time.time() if now is None else now
        with self.service._condition:
            with self.service._db:
                rows = self.service._db.execute("SELECT asset_id FROM assets WHERE expires<=? AND state!='expired'", (now,)).fetchall()
                self.service._db.execute("UPDATE assets SET state='expired' WHERE expires<=?", (now,))
            # Retry a deletion interrupted after the tombstone transaction too.
            expired = self.service._db.execute("SELECT asset_id FROM assets WHERE state='expired'").fetchall()
            for row in expired:
                self._unlink(row["asset_id"])
            os.fsync(self.fd)
            return len(rows)
