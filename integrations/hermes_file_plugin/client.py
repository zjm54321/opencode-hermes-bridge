"""Self-contained, stdlib-only local file protocol and descriptor-relative I/O."""

import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from urllib.parse import quote, urlsplit


MAX_FILE = 10 * 1024 * 1024
MAX_TOTAL = 20 * 1024 * 1024
MAX_ASSETS = 8
MAX_JSON = 64 * 1024
REGISTRATION_TIMEOUT = 5.0
REQUEST_TIMEOUT = 5.0
RETRY_INTERVAL = 0.1
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class BridgeError(Exception):
    """Only fixed, public-safe messages may be passed to this exception."""


def _safe_name(value):
    if (not isinstance(value, str) or not value or value in {".", ".."}
            or "/" in value or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)
            or len(value.encode("utf-8")) > 255):
        raise BridgeError("Invalid asset filename.")
    return value


def _mime(value):
    if (not isinstance(value, str) or len(value) > 255
            or not re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", value)):
        raise BridgeError("Invalid asset MIME type.")
    return value


def _uuid(value):
    try:
        valid = isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        valid = False
    if not valid:
        raise BridgeError("Invalid file service metadata.")
    return value


def _asset(value):
    if not isinstance(value, dict) or not {"asset_id", "name", "mime", "size", "sha256"} <= value.keys():
        raise BridgeError("Invalid file service metadata.")
    size, digest = value["size"], value["sha256"]
    if (type(size) is not int or not 0 <= size <= MAX_FILE
            or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
        raise BridgeError("Invalid file service metadata.")
    return {"asset_id": _uuid(value["asset_id"]), "name": _safe_name(value["name"]),
            "mime": _mime(value["mime"]), "size": size, "sha256": digest}


def _disposition(name):
    return "attachment; filename*=UTF-8''" + quote(name, safe="")


def _json(data):
    try:
        return json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise BridgeError("Invalid file service metadata.") from None


def _private(fd):
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise BridgeError("File workspace must be owned by this user with mode 0700.")


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _snapshot(parent_fd, name):
    fd = os.open(name, _FILE_FLAGS, dir_fd=parent_fd)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or before.st_nlink != 1 or before.st_size > MAX_FILE):
            raise BridgeError("Only private regular files up to 10 MiB can be published.")
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, min(64 * 1024, MAX_FILE + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_FILE:
                raise BridgeError("File exceeds the 10 MiB limit.")
        after = os.fstat(fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if _identity(before) != _identity(after) or _identity(after) != _identity(current) or total != before.st_size:
            raise BridgeError("File changed while taking its snapshot.")
        return b"".join(chunks)
    finally:
        os.close(fd)


@contextmanager
def _directory(parent_fd, name, create=False, private=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
    fd = os.open(name, _DIR_FLAGS, dir_fd=parent_fd)
    try:
        if private:
            _private(fd)
        yield fd
    finally:
        os.close(fd)


class Workspace:
    def __init__(self, root, run):
        self.root = root
        self.run = run
        self.path = root + "/" + run

    @contextmanager
    def open(self):
        # Walk from / using descriptors: no component may be a symlink.
        fd = os.open("/", _DIR_FLAGS)
        try:
            for component in self.root.split("/")[1:]:
                child = os.open(component, _DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
            _private(fd)
            with _directory(fd, self.run, create=True, private=True) as run_fd:
                yield run_fd
        finally:
            os.close(fd)

    def snapshot(self, run_fd, path):
        if not isinstance(path, str) or not path or "\0" in path or "\\" in path:
            raise BridgeError("File path must stay inside this run's workspace.")
        if path.startswith("/"):
            if not path.startswith(self.path + "/"):
                raise BridgeError("File path must stay inside this run's workspace.")
            path = path[len(self.path) + 1:]
        parts = path.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise BridgeError("File path must stay inside this run's workspace.")
        fd = os.dup(run_fd)
        try:
            for component in parts[:-1]:
                child = os.open(component, _DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
            return _snapshot(fd, parts[-1]), parts[-1]
        finally:
            os.close(fd)

    def deliver(self, run_fd, asset, data):
        with _directory(run_fd, "inputs", create=True, private=True) as inputs_fd:
            with _directory(inputs_fd, asset["asset_id"], create=True, private=True) as asset_fd:
                name = asset["name"]
                temp = ".bridge-" + uuid.uuid4().hex
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=asset_fd)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                    try:
                        # link + unlink is atomic create-if-absent, unlike replacing rename.
                        os.link(temp, name, src_dir_fd=asset_fd, dst_dir_fd=asset_fd, follow_symlinks=False)
                    except FileExistsError:
                        if _snapshot(asset_fd, name) != data:
                            raise BridgeError("An input path already contains different bytes.")
                finally:
                    os.unlink(temp, dir_fd=asset_fd)
                    os.fsync(asset_fd)
        return self.path + "/inputs/" + asset["asset_id"] + "/" + name


@dataclass(frozen=True)
class FileClient:
    root: str
    token: str = field(repr=False)
    scheme: str
    host: str
    port: int

    @classmethod
    def from_env(cls):
        if os.environ.get("HERMES_BRIDGE_FILES_LOCAL") != "1":
            raise BridgeError("File tools require explicit local-only mode.")
        root = os.environ.get("HERMES_BRIDGE_FILE_ROOT", "")
        token = os.environ.get("HERMES_BRIDGE_FILE_TOKEN", "")
        if (not root.startswith("/") or any(p in {"", ".", ".."} for p in root.split("/")[1:])
                or "\0" in root or not token or len(token) > 4096
                or any(not 33 <= ord(c) <= 126 for c in token)):
            raise BridgeError("A private absolute file root and separate file token are required.")
        origin = os.environ.get("HERMES_BRIDGE_FILES_URL", "http://127.0.0.1:8787")
        try:
            parsed = urlsplit(origin)
            host = parsed.hostname
            port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
            if (parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment
                    or parsed.username is not None or parsed.password is not None
                    or any(c in origin for c in "?#@%") or any(ord(c) <= 32 or ord(c) == 127 for c in origin)
                    or not 1 <= port <= 65535 or not host):
                raise ValueError
            # Avoid DNS completely, even for localhost. No proxy environment is read.
            host = "127.0.0.1" if host.lower() == "localhost" else host
            if not ipaddress.ip_address(host).is_loopback:
                raise ValueError
        except ValueError:
            raise BridgeError("File service URL must be a loopback origin without a path.") from None
        return cls(root, token, parsed.scheme, host, port)

    def _request(self, method, path, *, data=None, headers=None, limit=MAX_JSON, deadline=None, asset=None):
        end = min(deadline if deadline is not None else float("inf"), time.monotonic() + REQUEST_TIMEOUT)
        timeout = end - time.monotonic()
        if timeout <= 0:
            raise BridgeError("File service request timed out.")
        connection_class = http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
        conn = connection_class(self.host, self.port, timeout=timeout)
        timer = None
        response = None
        try:
            conn.connect()
            sock = conn.sock

            def abort():
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            remaining = end - time.monotonic()
            if remaining <= 0:
                raise BridgeError("File service request timed out.")
            # Also bounds trickled headers/body, not merely each socket recv.
            timer = threading.Timer(remaining, abort)
            timer.daemon = True
            timer.start()
            request_headers = {"Authorization": "Bearer " + self.token, "Connection": "close"}
            request_headers.update(headers or {})
            conn.request(method, path, body=data, headers=request_headers)
            response = conn.getresponse()
            status = response.status
            if status not in {200, 201}:
                return status, b""
            if asset is not None:
                expected = {"Content-Type": asset["mime"], "Content-Length": str(asset["size"]),
                            "Content-Disposition": _disposition(asset["name"]), "X-Content-SHA256": asset["sha256"]}
                if response.headers.get_all("Transfer-Encoding"):
                    raise BridgeError("Input asset headers failed validation.")
                for key, value in expected.items():
                    if response.headers.get_all(key) != [value]:
                        raise BridgeError("Input asset headers failed validation.")
            lengths = response.headers.get_all("Content-Length", [])
            if lengths and (len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]) or int(lengths[0]) > limit):
                raise BridgeError("File service response exceeds its size limit.")
            chunks, total = [], 0
            while True:
                if time.monotonic() >= end:
                    raise BridgeError("File service request timed out.")
                chunk = response.read1(min(64 * 1024, limit + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > limit:
                    raise BridgeError("File service response exceeds its size limit.")
            if lengths and total != int(lengths[0]):
                raise BridgeError("File service response was incomplete.")
            return status, b"".join(chunks)
        except (OSError, http.client.HTTPException, ValueError):
            raise BridgeError("File service request failed or was incomplete.") from None
        finally:
            if timer is not None:
                timer.cancel()
            if response is not None:
                response.close()
            conn.close()

    @staticmethod
    def _accepted(status, expected=(200,)):
        if status in {401, 403}:
            raise BridgeError("File service denied this run's file access.")
        if status not in expected:
            raise BridgeError("File service rejected the request.")

    def _inputs(self, run):
        deadline = time.monotonic() + REGISTRATION_TIMEOUT
        while True:
            status, data = self._request("GET", "/internal/runs/" + run + "/assets", deadline=deadline)
            if status != 404:
                self._accepted(status)
                break
            remaining = deadline - time.monotonic()
            if remaining <= RETRY_INTERVAL:
                raise BridgeError("Run is not registered for file access.")
            time.sleep(RETRY_INTERVAL)
        payload = _json(data)
        if not isinstance(payload, dict) or "job_id" not in payload or not isinstance(payload.get("input_assets"), list):
            raise BridgeError("Invalid file service metadata.")
        _uuid(payload["job_id"])
        if len(payload["input_assets"]) > MAX_ASSETS:
            raise BridgeError("Input assets exceed the 8 file / 20 MiB limit.")
        assets = [_asset(item) for item in payload["input_assets"]]
        if (sum(item["size"] for item in assets) > MAX_TOTAL
                or len({item["asset_id"] for item in assets}) != len(assets)):
            raise BridgeError("Input assets exceed the 8 file / 20 MiB limit.")
        return assets

    def files(self, run):
        assets = self._inputs(run)
        workspace = Workspace(self.root, run)
        with workspace.open() as fd:
            files = []
            for asset in assets:
                status, data = self._request("GET", "/internal/runs/" + run + "/assets/" + asset["asset_id"],
                                             limit=asset["size"], asset=asset)
                self._accepted(status)
                if len(data) != asset["size"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
                    raise BridgeError("Input asset bytes failed integrity validation.")
                path = workspace.deliver(fd, asset, data)
                files.append({**asset, "path": path})
            return {"workspace": workspace.path, "input_assets": files}

    def publish(self, run, path, name=None, mime=None):
        self._inputs(run)
        workspace = Workspace(self.root, run)
        with workspace.open() as fd:
            data, basename = workspace.snapshot(fd, path)
            metadata = {"name": _safe_name(basename if name is None else name),
                        "mime": _mime("application/octet-stream" if mime is None else mime),
                        "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            stable_key = json.dumps(metadata, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
            asset = {"asset_id": str(uuid.uuid5(uuid.UUID(run[4:]), stable_key)), **metadata}
            headers = {"Content-Type": asset["mime"], "Content-Length": str(asset["size"]),
                       "Content-Disposition": _disposition(asset["name"]), "X-Content-SHA256": asset["sha256"]}
            status, result = self._request("PUT", "/internal/runs/" + run + "/assets/" + asset["asset_id"],
                                           data=data, headers=headers)
            self._accepted(status, (200, 201))
            if _asset(_json(result)) != asset:
                raise BridgeError("Published asset acknowledgement failed validation.")
            return asset
