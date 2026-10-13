"""Authenticated jobs boundary; production forwards only to the native Gateway."""

from __future__ import annotations

import argparse
import hmac
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import re
from typing import Any
from urllib.parse import quote, unquote_to_bytes

from .core import BridgeError, JobService, private_directory, wire_json
from .runner import GatewayRunner
from .assets import MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, MAX_ASSETS, metadata


def file_authorization(token: str, public_token: str) -> bytes | None:
    if token == "":
        return None
    if (not isinstance(token, str) or not all(33 <= ord(c) < 127 for c in token)
            or hmac.compare_digest(token.encode("ascii"), public_token.encode("utf-8"))):
        raise ValueError("File token must be a distinct nonempty ASCII bearer token.")
    return ("Bearer " + token).encode("ascii")


def reject_constant(_: str) -> None:
    raise ValueError("Non-JSON constant")


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON key")
        value[key] = item
    return value


class BridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], service: JobService, token: str, *, request_timeout: float = 10,
                 file_token: str | None = None):
        if not isinstance(token, str) or not token.strip():
            raise ValueError("HERMES_BRIDGE_TOKEN must be nonempty.")
        try:
            self._authorization = ("Bearer " + token).encode("ascii")
        except UnicodeError:
            raise ValueError("HERMES_BRIDGE_TOKEN must be an ASCII bearer token.") from None
        if any(ord(c) <= 32 or ord(c) == 127 for c in token):
            raise ValueError("HERMES_BRIDGE_TOKEN must not contain whitespace or control characters.")
        if request_timeout <= 0:
            raise ValueError("Request timeout must be positive.")
        self.service = service
        file_token = os.environ.get("HERMES_BRIDGE_FILE_TOKEN", "") if file_token is None else file_token
        self._file_authorization = file_authorization(file_token, token)
        service.files_enabled = self._file_authorization is not None
        self.request_timeout = request_timeout
        super().__init__(address, BridgeHandler)

    def get_request(self) -> tuple[socket.socket, Any]:
        client, address = super().get_request()
        client.settimeout(self.request_timeout)
        return client, address

    def handle_error(self, request: Any, client_address: Any) -> None:
        # BaseServer prints tracebacks, possibly including private inputs/provider secrets.
        pass


class BridgeHandler(BaseHTTPRequestHandler):
    server: BridgeHTTPServer
    protocol_version = "HTTP/1.1"
    server_version = "HermesBridge"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._send(code, {"error": {"code": "http_error", "message": "Invalid HTTP request."}})

    def _send(self, status: int, value: Any) -> None:
        payload = wire_json(value)
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _auth(self, internal: bool = False) -> None:
        values = self.headers.get_all("Authorization", [])
        received = values[0].encode("latin-1") if len(values) == 1 else b""
        expected = self.server._file_authorization if internal else self.server._authorization
        if expected is None or not hmac.compare_digest(received, expected):
            raise BridgeError("unauthorized", "A valid bearer token is required.", 401)
        if internal:
            peer = ipaddress.ip_address(self.client_address[0])
            if not (peer.is_loopback or getattr(peer, "ipv4_mapped", None) and peer.ipv4_mapped.is_loopback):
                raise BridgeError("forbidden", "Internal file access requires a loopback peer.", 403)

    def _single(self, name: str) -> str:
        values = self.headers.get_all(name, [])
        if len(values) != 1:
            raise BridgeError("invalid_asset_headers", "A single value for each asset header is required.")
        return values[0]

    def _asset_metadata(self, asset_id: str) -> dict[str, Any]:
        if self.headers.get_all("Transfer-Encoding"):
            raise BridgeError("unsupported_transfer_encoding", "Transfer-Encoding is not supported.")
        length = self._single("Content-Length")
        if not length.isascii() or not length.isdecimal() or len(length) > 20:
            raise BridgeError("invalid_length", "Invalid Content-Length.")
        if int(length) > MAX_ASSET_BYTES:
            raise BridgeError("payload_too_large", "Asset exceeds configured limits.", 413)
        disposition = self._single("Content-Disposition")
        prefix = "attachment; filename*=UTF-8''"
        if not disposition.startswith(prefix):
            raise BridgeError("invalid_asset_headers", "Invalid asset Content-Disposition.")
        encoded = disposition[len(prefix):]
        if re.fullmatch(r"(?:[A-Za-z0-9!#$&+.^_`|~*'()-]|%[0-9A-Fa-f]{2})+", encoded) is None:
            raise BridgeError("invalid_asset_headers", "Invalid encoded asset filename.")
        try:
            name = unquote_to_bytes(encoded).decode("utf-8")
        except UnicodeError:
            raise BridgeError("invalid_asset_headers", "Asset filename must be UTF-8.") from None
        return metadata(asset_id, name, self._single("Content-Type"), int(length), self._single("X-Content-SHA256"))

    def _send_asset(self, asset: dict[str, Any], body: bytes) -> None:
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", asset["mime"])
        self.send_header("Content-Length", str(asset["size"]))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(asset["name"], safe=""))
        self.send_header("X-Content-SHA256", asset["sha256"])
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _files_enabled(self) -> None:
        if self.server._file_authorization is None:
            raise BridgeError("assets_disabled", "File transfer is not configured.", 415)

    def _body(self) -> Any:
        if self.headers.get_all("Transfer-Encoding"):
            raise BridgeError("unsupported_transfer_encoding", "Transfer-Encoding is not supported.")
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            raise BridgeError("length_required", "Content-Length is required.", 411)
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal() or len(lengths[0]) > 20:
            raise BridgeError("invalid_length", "Invalid Content-Length.")
        length = int(lengths[0])
        if length > self.server.service.limits.body:
            raise BridgeError("payload_too_large", "Request body exceeds configured limits.", 413)
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
            raise BridgeError("unsupported_media_type", "Content-Type must be application/json.", 415)
        # Bound actual reads, never read an unbounded stream based on client input.
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise BridgeError("invalid_length", "Request body is incomplete.")
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=reject_constant, object_pairs_hook=unique_object)
        except (UnicodeError, ValueError, RecursionError):
            raise BridgeError("invalid_json", "Request body must be valid UTF-8 JSON.") from None

    def _handle(self, method: str) -> None:
        try:
            internal = self.path.startswith("/internal/")
            self._auth(internal)
            public_asset = re.fullmatch(r"/v1/jobs/([^/?#]+)/assets/([^/?#]+)", self.path)
            internal_asset = re.fullmatch(r"/internal/runs/([^/?#]+)/assets(?:/([^/?#]+))?", self.path)
            if method == "GET" and self.path == "/v1/capabilities":
                self._send(200, {"object": "hermes.bridge.capabilities", "version": 1,
                                "assets": self.server._file_authorization is not None,
                                "max_asset_bytes": MAX_ASSET_BYTES, "max_total_asset_bytes": MAX_TOTAL_ASSET_BYTES,
                                "max_assets": MAX_ASSETS})
            elif public_asset and method in ("GET", "PUT"):
                self._files_enabled()
                job_id, asset_id = public_asset.groups()
                if method == "PUT":
                    status, asset = self.server.service.assets.put(job_id, self._asset_metadata(asset_id), self.rfile)
                    self._send(status, asset)
                else:
                    self._send_asset(*self.server.service.assets.get(job_id, asset_id))
            elif internal_asset and method in ("GET", "PUT"):
                self._files_enabled()
                run_id, asset_id = internal_asset.groups()
                store = self.server.service.assets
                if asset_id is None and method == "GET":
                    self._send(200, store.list_inputs(run_id))
                elif asset_id is not None and method == "PUT":
                    status, asset = store.put_output(run_id, self._asset_metadata(asset_id), self.rfile)
                    self._send(status, asset)
                elif asset_id is not None:
                    self._send_asset(*store.get(None, asset_id, run_id=run_id))
                else:
                    raise BridgeError("not_found", "Route not found.", 404)
            elif method == "POST" and self.path == "/v1/jobs":
                body = self._body()
                if isinstance(body, dict) and "input_assets" in body:
                    self._files_enabled()
                job_id = self.server.service.submit(body)
                self._send(202, {"id": job_id})
            elif method == "GET" and self.path.startswith("/v1/jobs/") and "?" not in self.path:
                self._send(200, self.server.service.get(self.path[len("/v1/jobs/"):]))
            else:
                raise BridgeError("not_found", "Route not found.", 404)
        except BridgeError as exc:
            self._send(exc.status, {"error": {"code": exc.code, "message": exc.message}})
        except (TimeoutError, socket.timeout):
            self._send(408, {"error": {"code": "request_timeout", "message": "Request timed out."}})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self._send(500, {"error": {"code": "internal_error", "message": "Internal companion error."}})

    def do_POST(self) -> None:
        self._handle("POST")

    def do_GET(self) -> None:
        self._handle("GET")

    def do_PUT(self) -> None:
        self._handle("PUT")


def main() -> None:
    parser = argparse.ArgumentParser(description="Authenticated Hermes Gateway bridge. Set HERMES_GATEWAY_URL (base URL) and HERMES_GATEWAY_TOKEN separately from HERMES_BRIDGE_TOKEN. HTTP on trusted networks is supported; use TLS on untrusted networks.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--workspace", type=Path, default=Path.home() / ".local/share/opencode-hermes-bridge")
    parser.add_argument("--request-timeout", type=float, default=10)
    parser.add_argument("--asset-ttl", type=float, default=86400, help="Asset byte retention in seconds; ID tombstones are permanent.")
    args = parser.parse_args()
    token = os.environ.get("HERMES_BRIDGE_TOKEN", "")
    if not token.strip():
        parser.error("HERMES_BRIDGE_TOKEN must be nonempty.")
    try:
        runner = GatewayRunner()
    except ValueError:
        parser.error("Invalid Gateway configuration; check HERMES_GATEWAY_URL and HERMES_GATEWAY_TOKEN.")
    file_token = os.environ.get("HERMES_BRIDGE_FILE_TOKEN", "")
    try:
        file_authorization(file_token, token)
    except ValueError:
        parser.error("Invalid HERMES_BRIDGE_FILE_TOKEN; it must be distinct from the public bearer token.")
    os.umask(0o077)
    workspace = private_directory(args.workspace.absolute())
    # Exactly once, before starting threads. Never chdir per request.
    os.chdir(workspace)
    try:
        service = JobService(workspace, runner, files_enabled=bool(file_token), asset_ttl=args.asset_ttl)
    except Exception:
        parser.error("Unable to open private workspace; check permissions and ensure no other companion owns it.")
    try:
        try:
            server = BridgeHTTPServer((args.host, args.port), service, token, request_timeout=args.request_timeout, file_token=file_token)
        except (ValueError, OSError):
            parser.error("Unable to initialize companion; check bind address, port, timeout, and bearer token format.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    finally:
        service.close()
