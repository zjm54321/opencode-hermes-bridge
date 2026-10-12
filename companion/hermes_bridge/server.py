"""Authenticated jobs boundary; production forwards only to the native Gateway."""

from __future__ import annotations

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
from typing import Any

from .core import BridgeError, JobService, private_directory, wire_json
from .runner import GatewayRunner


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

    def __init__(self, address: tuple[str, int], service: JobService, token: str, *, request_timeout: float = 10):
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

    def _auth(self) -> None:
        values = self.headers.get_all("Authorization", [])
        received = values[0].encode("latin-1") if len(values) == 1 else b""
        if not hmac.compare_digest(received, self.server._authorization):
            raise BridgeError("unauthorized", "A valid bearer token is required.", 401)

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
            self._auth()
            if method == "POST" and self.path == "/v1/jobs":
                job_id = self.server.service.submit(self._body())
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Authenticated Hermes Gateway bridge. Set HERMES_GATEWAY_URL (base URL) and HERMES_GATEWAY_TOKEN separately from HERMES_BRIDGE_TOKEN. HTTP on trusted networks is supported; use TLS on untrusted networks.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--workspace", type=Path, default=Path.home() / ".local/share/opencode-hermes-bridge")
    parser.add_argument("--request-timeout", type=float, default=10)
    args = parser.parse_args()
    token = os.environ.get("HERMES_BRIDGE_TOKEN", "")
    if not token.strip():
        parser.error("HERMES_BRIDGE_TOKEN must be nonempty.")
    try:
        runner = GatewayRunner()
    except ValueError:
        parser.error("Invalid Gateway configuration; check HERMES_GATEWAY_URL and HERMES_GATEWAY_TOKEN.")
    os.umask(0o077)
    workspace = private_directory(args.workspace.absolute())
    # Exactly once, before starting threads. Never chdir per request.
    os.chdir(workspace)
    try:
        service = JobService(workspace, runner)
    except Exception:
        parser.error("Unable to open private workspace; check permissions and ensure no other companion owns it.")
    try:
        try:
            server = BridgeHTTPServer((args.host, args.port), service, token, request_timeout=args.request_timeout)
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
