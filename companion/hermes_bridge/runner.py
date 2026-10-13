"""Thin, at-most-once admission client for Hermes Gateway's native /v1/runs."""

from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
import re
import socket
import threading
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .core import BridgeError, RunInput, RunPaused, RunResult, fail_size, outcome_unknown, wire_json


MAX_NATIVE_BODY = 10_000_000
# v2026.9.24 api_server_runs.py: queued admission, execution, approval and stop.
NONTERMINAL = frozenset(("queued", "running", "waiting_for_approval", "stopping"))
TERMINAL = frozenset(("completed", "failed", "cancelled", "interrupted"))
RUN_ID = re.compile(r"run_[0-9a-f]{32}\Z")


class _TransportFailure(Exception):
    pass


class _ProtocolFailure(Exception):
    pass


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _ProtocolFailure()
        result[key] = value
    return result


def _constant(_: str) -> None:
    raise _ProtocolFailure()


class GatewayRunner:
    """No Agent imports, local profile, model routing, or native POST replay.

    HERMES_GATEWAY_URL is the Gateway base URL (optionally a path prefix), not
    /v1/runs. Credentials are independent of HERMES_BRIDGE_TOKEN. Only a hash of
    this target/credential scope enters the service's existing SQLite ledger.
    """

    def __init__(self, url: str | None = None, token: str | None = None, *,
                 timeout: float = 5, poll_interval: float = 1, max_poll_interval: float = 10,
                 response_limit: int = MAX_NATIVE_BODY):
        url = os.environ.get("HERMES_GATEWAY_URL", "") if url is None else url
        token = os.environ.get("HERMES_GATEWAY_TOKEN", "") if token is None else token
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme in ("http", "https") and bool(parsed.hostname)
                     and parsed.username is None and parsed.password is None
                     and not any(c in url for c in "?#\\")
                     and all(33 <= ord(c) < 127 for c in url)
                     and "%" not in parsed.netloc)
            port = parsed.port
            authority = f"[{parsed.hostname}]" if parsed.hostname and ":" in parsed.hostname else parsed.hostname
            if port is not None:
                authority = f"{authority}:{port}"
            valid = valid and parsed.netloc.lower() == authority
        except (TypeError, ValueError):
            valid = False
        if not valid:
            raise ValueError("HERMES_GATEWAY_URL must be an HTTP(S) base URL without userinfo, query, or fragment.")
        if not isinstance(token, str) or not token or not all(33 <= ord(c) < 127 for c in token):
            raise ValueError("HERMES_GATEWAY_TOKEN must be a nonempty ASCII bearer token without whitespace.")
        if (not math.isfinite(timeout) or not 0 < timeout <= 10
                or not math.isfinite(poll_interval) or not 0 < poll_interval <= 10
                or not math.isfinite(max_poll_interval) or not poll_interval <= max_poll_interval <= 60
                or type(response_limit) is not int or not 1 <= response_limit <= MAX_NATIVE_BODY):
            raise ValueError("Invalid Gateway request limits.")
        host = parsed.hostname
        netloc = f"[{host}]" if ":" in host else host
        if port is not None:
            netloc += f":{port}"
        self.url = urlunsplit((parsed.scheme, netloc, parsed.path.rstrip("/"), "", ""))
        self._host, self._port, self._https = host, port, parsed.scheme == "https"
        self._path = parsed.path.rstrip("/") + "/v1/runs"
        self._token = token
        self.scope = hashlib.sha256(wire_json([self.url, hashlib.sha256(token.encode("ascii")).hexdigest()])).hexdigest()
        self.timeout, self.poll_interval = timeout, poll_interval
        self.max_poll_interval, self.response_limit = max_poll_interval, response_limit
        self._stopped = threading.Event()

    def stop(self) -> None:
        """Stop local waiting only; never call the native stop endpoint."""
        self._stopped.set()

    def _exchange(self, method: str, path: str, body: bytes | None = None,
                  job_id: str | None = None) -> tuple[int, Any]:
        # http.client neither redirects nor consults environment proxies. The
        # daemon bounds DNS, slow headers and slow body reads by a wall deadline,
        # not merely a socket inactivity timeout. It never retries a request.
        connection_type = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        connection = connection_type(self._host, self._port, timeout=self.timeout)
        done, abandoned = threading.Event(), threading.Event()
        reply: list[tuple[int, bytes]] = []
        failed: list[type[Exception]] = []

        def transfer() -> None:
            try:
                connection.connect()
                # DNS/connect can outlive the caller; never send after abandonment.
                if abandoned.is_set() or self._stopped.is_set():
                    return
                headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json",
                           "Connection": "close"}
                if body is not None:
                    headers["Content-Type"] = "application/json"
                    headers["Idempotency-Key"] = job_id
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                if response.status not in (200, 202):
                    # Discard raw error pages, including redirect Location values.
                    reply.append((response.status, b""))
                    return
                length = response.getheader("Content-Length")
                if (response.getheader("Content-Encoding", "identity") != "identity"
                        or (length is not None and (not length.isascii() or not length.isdecimal()
                                                   or len(length) > 20 or int(length) > self.response_limit))):
                    raise _ProtocolFailure()
                raw = response.read(self.response_limit + 1)
                if len(raw) > self.response_limit or (length is not None and len(raw) != int(length)):
                    raise _ProtocolFailure()
                reply.append((response.status, raw))
            except _ProtocolFailure:
                failed.append(_ProtocolFailure)
            except (http.client.RemoteDisconnected, http.client.IncompleteRead):
                failed.append(_TransportFailure)
            except http.client.HTTPException:
                # Incompatible status/framing is not a temporary outage.
                failed.append(_ProtocolFailure)
            except Exception:
                # Never retain exceptions: HTTP and TLS errors may include secrets.
                failed.append(_TransportFailure)
            finally:
                try:
                    connection.close()
                except Exception:
                    pass
                finally:
                    done.set()

        if self._stopped.is_set():
            raise RunPaused()
        deadline = time.monotonic() + self.timeout
        threading.Thread(target=transfer, name="gateway-http", daemon=True).start()
        try:
            while not done.wait(min(0.05, max(0, deadline - time.monotonic()))):
                if self._stopped.is_set():
                    raise RunPaused()
                if time.monotonic() >= deadline:
                    raise _TransportFailure()
            if failed:
                if self._stopped.is_set():
                    raise RunPaused()
                raise failed[0]()
            if not reply:
                raise RunPaused()
            status, raw = reply[0]
            if status not in (200, 202):
                return status, None
            try:
                value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise _ProtocolFailure() from None
            if not isinstance(value, dict):
                raise _ProtocolFailure()
            return status, value
        finally:
            abandoned.set()
            sock = connection.sock
            if not done.is_set() and sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def run(self, request: RunInput) -> RunResult:
        session_id = "opencode-" + request.thread_id
        text = request.text
        if request.input_assets is not None:
            text += ("\n\nTask files: call bridge_files to obtain this run's controlled workspace and input files. "
                     "For deliverable files, call bridge_publish_file after writing them there. "
                     "Files are opaque bytes; do not assume ZIP contents should be executed.")
        native_input: Any = text
        if request.attachments:
            parts = [{"type": "text", "text": text}]
            parts.extend({"type": "image_url", "image_url": {
                "url": f"data:{item['mime']};base64,{item['base64']}"}} for item in request.attachments)
            native_input = [{"role": "user", "content": parts}]
        body = wire_json({"input": native_input, "session_id": session_id})
        if len(body) > MAX_NATIVE_BODY:
            fail_size()
        if request.checkpoint is None:
            raise BridgeError("gateway_checkpoint_required", "A durable Gateway checkpoint is required.", 500)
        record, fresh = request.checkpoint.prepare(body, self.scope, session_id)
        run_id = record.run_id
        if run_id is None:
            if not fresh:
                raise outcome_unknown()
            try:
                status, value = self._exchange("POST", self._path, record.body, request.job_id)
                if (status != 202 or not isinstance(value.get("run_id"), str)
                        or RUN_ID.fullmatch(value["run_id"]) is None):
                    raise outcome_unknown()
                run_id = value["run_id"]
                # Receipt is durable even if other fields of this 202 are malformed.
                request.checkpoint.accepted(run_id)
                if (not isinstance(value.get("status"), str)
                        or value["status"] not in NONTERMINAL | TERMINAL | {"started"}
                        or type(value.get("replayed")) is not bool):
                    raise outcome_unknown()
            except RunPaused:
                raise
            except Exception:
                # Includes receipt-checkpoint failures after remote admission.
                raise outcome_unknown() from None
        elif RUN_ID.fullmatch(run_id) is None:
            raise outcome_unknown()
        delay = self.poll_interval
        while True:
            if self._stopped.is_set():
                raise RunPaused()
            try:
                status, value = self._exchange("GET", self._path + "/" + run_id)
                if status == 429 or 500 <= status <= 599:
                    raise _TransportFailure()
                if status != 200 or value.get("run_id") != run_id:
                    raise outcome_unknown()
                state = value.get("status")
                if not isinstance(state, str) or state not in NONTERMINAL | TERMINAL:
                    raise outcome_unknown()
                if state in TERMINAL:
                    if (state != "completed" or value.get("completed") is False
                            or any(value.get(flag) is True for flag in ("failed", "partial", "interrupted"))
                            or value.get("error") is not None):
                        raise BridgeError("gateway_incomplete", "Gateway did not complete the job.", 502)
                    # Native terminal_run_status always emits these three bools.
                    # Missing/malformed flags must not turn a partial response
                    # from an incompatible endpoint into a successful job.
                    if (value.get("completed") is not True or value.get("partial") is not False
                            or value.get("interrupted") is not False
                            or ("failed" in value and type(value["failed"]) is not bool)):
                        raise BridgeError("invalid_result", "Gateway returned an invalid result.", 502)
                    if not isinstance(value.get("output"), str):
                        raise BridgeError("invalid_result", "Gateway returned an invalid result.", 502)
                    if (re.search(r"\bMEDIA:", value["output"], re.IGNORECASE)
                            and not (request.input_assets is not None and request.checkpoint.has_output_assets())):
                        raise BridgeError("unsupported_output", "Gateway file output is not supported.", 502)
                    return RunResult(value["output"])
                delay = self.poll_interval
            except _ProtocolFailure:
                raise outcome_unknown() from None
            except _TransportFailure:
                # A known native run may finish while its status endpoint is
                # unavailable. Keep the local job running and retry GET only;
                # cap the backoff, not the number of chances to recover it.
                delay = min(self.max_poll_interval, delay * 2)
            if self._stopped.wait(delay):
                raise RunPaused()


# Import compatibility only: the old in-process Agent backend no longer exists.
HermesRunner = GatewayRunner
