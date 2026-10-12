from __future__ import annotations

import base64
from contextlib import closing, redirect_stderr
import http.client
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from hermes_bridge import BridgeError, JobService, Limits, RunResult
from hermes_bridge.core import export_result, normalize_job, wire_json
from hermes_bridge.server import BridgeHTTPServer, main
from http_fixture import EchoRunner


TOKEN = "test-token-not-production"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==")


def attachment(name: str, mime: str, data: bytes) -> dict[str, str]:
    return {"name": name, "mime": mime, "base64": base64.b64encode(data).decode()}


def job(text: str = "hello", *, thread: str | None = None, files: list | None = None) -> dict:
    return {"id": str(uuid4()), "threadId": thread or str(uuid4()), "text": text, "attachments": files or []}


def wait_done(service: JobService, job_id: str) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = service.get(job_id)
        if result["status"] in ("completed", "failed"):
            return result
        time.sleep(0.005)
    raise AssertionError("Job did not finish within 5 seconds")


class FunctionRunner:
    scope = "test-only-inline-adapter-v1"

    def __init__(self, function):
        self.function = function

    def run(self, request):
        return self.function(request)


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hermes-test-")
        self.root = Path(self.temp.name) / "private"
        self.services = []

    def tearDown(self):
        for service in reversed(self.services):
            service.close()
        self.temp.cleanup()

    def service(self, runner=None, **kwargs):
        service = JobService(self.root, runner or EchoRunner(), **kwargs)
        self.services.append(service)
        return service

    def close_service(self, service):
        service.close()
        self.services.remove(service)

    def test_images_no_local_files_or_history_and_immutable_poll(self):
        seen = []
        def run(request):
            seen.append(request)
            return EchoRunner().run(request)
        service = self.service(FunctionRunner(run))
        first = job(files=[attachment("pixel.png", "image/png", PNG)])
        service.submit(first)
        result = wait_done(service, first["id"])
        self.assertEqual((result["status"], result["text"], result["attachments"]),
                         ("completed", "hello", first["attachments"]))
        self.assertEqual(list((self.root / "jobs").iterdir()), [])
        self.assertFalse(hasattr(seen[0], "conversation_history"))
        self.close_service(service)
        service = self.service(FunctionRunner(run))
        self.assertEqual(service.get(first["id"]), result)
        second = job("second", thread=first["threadId"])
        service.submit(second)
        self.assertEqual(wait_done(service, second["id"])["status"], "completed")
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM threads").fetchone()[0], 0)

    def test_fifo_single_worker_and_empty_running_result(self):
        entered, release = threading.Event(), threading.Event()
        calls, active, maximum = [], 0, 0
        lock = threading.Lock()
        def run(request):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            calls.append(request)
            if len(calls) == 1:
                entered.set()
                self.assertTrue(release.wait(3))
            result = EchoRunner().run(request)
            with lock:
                active -= 1
            return result
        service = self.service(FunctionRunner(run))
        first = job("one")
        second, third = job("two", thread=first["threadId"]), job("three", thread=first["threadId"])
        service.submit(first)
        try:
            self.assertTrue(entered.wait(3))
            service.submit(second)
            service.submit(third)
            for value, expected in [(first, "running"), (second, "queued"), (third, "queued")]:
                response = service.get(value["id"])
                self.assertEqual(response["status"], expected)
                self.assertEqual((response["text"], response["attachments"], response["error"]), ("", [], None))
        finally:
            release.set()
        self.assertEqual(wait_done(service, third["id"])["status"], "completed")
        self.assertEqual([r.text for r in calls], ["one", "two", "three"])
        self.assertEqual(maximum, 1)

    def test_runner_exception_redacted_worker_survives(self):
        service = self.service()
        first, second = job("__fixture_fail__"), job("next")
        service.submit(first)
        service.submit(second)
        result = wait_done(service, first["id"])
        self.assertEqual(result["error"]["code"], "execution_failed")
        self.assertNotIn("test-provider-secret", json.dumps(result))
        self.assertEqual(wait_done(service, second["id"])["status"], "completed")

    def test_export_utility_rejects_unsafe_paths_without_production_use(self):
        output = self.root / "output"
        output.mkdir(parents=True)
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_bytes(b"private")
        (output / "link").symlink_to(outside)
        (output / "linkdir").symlink_to(outside.parent, target_is_directory=True)
        os.mkfifo(output / "fifo")
        for path in [outside, str(output / ".." / "outside.txt"), "relative.txt", output / "link",
                     output / "linkdir" / outside.name, output / "fifo", output,
                     "https://example.invalid/a.png", output / "missing.txt"]:
            with self.subTest(path=path), self.assertRaises(BridgeError) as context:
                export_result(RunResult(f"prefix\nMEDIA:{path}"), output, Limits())
            self.assertEqual(context.exception.code, "unsafe_output")
        nested = output / "nested"
        nested.mkdir()
        target = nested / "space name.txt"
        target.write_bytes(b"bytes")
        text, files = export_result(RunResult(f"answer\n  MEDIA:{target}\n", [
            {"role": "assistant", "content": "MEDIA:/etc/passwd"}]), output, Limits())
        self.assertEqual((text, files), ("answer", [attachment("space name.txt", "text/plain", b"bytes")]))
        service = self.service(FunctionRunner(lambda request: RunResult(f"answer\nMEDIA:{outside}")))
        value = job()
        service.submit(value)
        self.assertEqual(wait_done(service, value["id"])["error"]["code"], "unsupported_output")

    def test_output_file_total_count_text_and_wire_limits(self):
        limits = Limits(body=600, text=20, files=2, file_bytes=10, total_bytes=15)
        output = self.root / "output"
        output.mkdir(parents=True)
        results = [RunResult("x" * 21), RunResult("x" * 601)]
        for mode, count, size in [("file", 1, 11), ("total", 2, 8), ("count", 3, 1)]:
            lines = []
            for n in range(count):
                path = output / f"{mode}{n}.txt"
                path.write_bytes(b"x" * size)
                lines.append(f"MEDIA:{path}")
            results.append(RunResult("\n".join(lines)))
        for result in results:
            with self.subTest(result=result), self.assertRaises(BridgeError) as context:
                export_result(result, output, limits)
            self.assertEqual(context.exception.status, 413)
        service = self.service(FunctionRunner(lambda request: RunResult("x" * 21)), limits=limits)
        value = job()
        service.submit(value)
        self.assertEqual(wait_done(service, value["id"])["error"]["code"], "output_too_large")

    def test_private_permissions_single_owner_and_dedup(self):
        service = self.service(autostart=False)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / "jobs").stat().st_mode), 0o700)
        for path in self.root.glob("bridge.sqlite3*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaisesRegex(ValueError, "already owned"):
            JobService(self.root, EchoRunner())
        value = job(files=[attachment("a.png", "IMAGE/PNG", PNG)])
        service.submit(value)
        same = json.loads(json.dumps(value))
        same["id"], same["threadId"] = same["id"].upper(), same["threadId"].upper()
        same["attachments"][0]["mime"] = "image/png"
        self.assertEqual(service.submit(same), value["id"])
        same["text"] = "different"
        with self.assertRaises(BridgeError) as context:
            service.submit(same)
        self.assertEqual(context.exception.status, 409)
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)


class ValidationTests(unittest.TestCase):
    def test_names_mime_and_strict_base64(self):
        for name in ["../x", "/absolute", "a/b", "a\\b", "\x00bad", "..", ".", "", "C:drive", "a\nb"]:
            with self.subTest(name=name), self.assertRaises(BridgeError):
                normalize_job(job(files=[attachment(name, "image/png", b"x")]), Limits())
        for mime in ["", "text", "text/plain\r\nx: y", "text/plain; charset=utf-8", "text /plain"]:
            with self.subTest(mime=mime), self.assertRaises(BridgeError):
                normalize_job(job(files=[attachment("x", mime, b"x")]), Limits())
        for encoded in ["!!!!", "Zg", "Zg===", "Zg==\n", "Zh==", "é"]:
            with self.subTest(base64=encoded), self.assertRaises(BridgeError):
                normalize_job(job(files=[{"name": "x", "mime": "image/png", "base64": encoded}]), Limits())
        with self.assertRaises(BridgeError):
            normalize_job(job(files=[attachment("x", "image/png", b"a")] * 2), Limits())

    def test_input_limits_and_unicode(self):
        limits = Limits(text=5, files=2, file_bytes=3, total_bytes=5)
        cases = [job("123456"), job("汉字"), job(files=[attachment("x", "image/png", b"1234")]),
                 job(files=[attachment(str(n), "image/png", b"123") for n in range(2)]),
                 job(files=[attachment(str(n), "image/png", b"") for n in range(3)])]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(BridgeError) as context:
                normalize_job(value, limits)
            self.assertEqual(context.exception.status, 413)
        for value in [job("\ud800"), {**job(), "id": "invalid"}]:
            with self.assertRaises(BridgeError):
                normalize_job(value, limits)

    def test_server_gateway_failure_sanitized_before_workspace_or_worker(self):
        secret = "sentinel-gateway-key-never-export"
        env = {"HERMES_BRIDGE_TOKEN": TOKEN, "HERMES_GATEWAY_TOKEN": secret,
               "HERMES_GATEWAY_URL": f"http://user:{secret}@example.invalid"}
        output = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch("sys.argv", ["companion"]), redirect_stderr(output):
            with patch("hermes_bridge.server.private_directory") as workspace, patch("hermes_bridge.server.JobService") as service:
                with self.assertRaises(SystemExit) as context:
                    main()
                self.assertEqual(context.exception.code, 2)
                workspace.assert_not_called()
                service.assert_not_called()
        self.assertIn("Invalid Gateway configuration", output.getvalue())
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hermes-http-")
        self.service = JobService(self.temp.name, EchoRunner(), autostart=False,
                                  limits=Limits(body=2048, text=32, files=2, file_bytes=16, total_bytes=24))
        self.server = BridgeHTTPServer(("127.0.0.1", 0), self.service, TOKEN, request_timeout=0.2)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.address = self.server.server_address

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.service.close()
        self.temp.cleanup()

    def request(self, method="POST", path="/v1/jobs", value=None, *, raw=None, headers=None):
        connection = http.client.HTTPConnection(*self.address, timeout=2)
        body = raw if raw is not None else wire_json(value) if value is not None else None
        defaults = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
        if headers is not None:
            defaults.update(headers)
        connection.request(method, path, body=body, headers=defaults)
        response = connection.getresponse()
        payload = response.read()
        status, response_headers = response.status, response.getheaders()
        connection.close()
        self.assertEqual(int(dict(response_headers)["Content-Length"]), len(payload))
        return status, json.loads(payload)

    def raw_request(self, request: bytes, *, shutdown=True):
        with socket.create_connection(self.address, timeout=2) as connection:
            connection.sendall(request)
            if shutdown:
                connection.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                part = connection.recv(8192)
                if not part:
                    break
                chunks.append(part)
        header, body = b"".join(chunks).split(b"\r\n\r\n", 1)
        return int(header.split(b" ")[1]), json.loads(body)

    def test_202_poll_dedup_conflict_and_unknown(self):
        value = job(files=[attachment("hello.png", "image/png", b"hello")])
        self.assertEqual(self.request(value=value), (202, {"id": value["id"]}))
        self.assertEqual(self.request(value=value)[0], 202)
        with closing(sqlite3.connect(Path(self.temp.name) / "bridge.sqlite3")) as db:
            self.assertEqual(json.loads(db.execute("SELECT input FROM jobs WHERE id=?", (value["id"],)).fetchone()[0]), value)
        self.assertEqual(self.request(value={**value, "text": "different"})[0], 409)
        status, queued = self.request("GET", "/v1/jobs/" + value["id"])
        self.assertEqual((status, queued["status"], queued["text"], queued["attachments"]), (200, "queued", "", []))
        self.service.start()
        wait_done(self.service, value["id"])
        status, completed = self.request("GET", "/v1/jobs/" + value["id"])
        self.assertEqual((status, completed["status"], completed["attachments"]), (200, "completed", value["attachments"]))
        self.assertEqual(self.request("GET", "/v1/jobs/" + str(uuid4()))[0], 404)
        self.assertEqual(self.request("GET", "/not-found")[0], 404)

    def test_auth_required_for_submit_and_poll(self):
        for token in ["", "Bearer wrong", "bearer " + TOKEN, "Basic " + TOKEN]:
            for method, path in [("POST", "/v1/jobs"), ("GET", "/v1/jobs/" + str(uuid4()))]:
                with self.subTest(token=token, method=method):
                    self.assertEqual(self.request(method, path, value=job(), headers={"Authorization": token})[0], 401)
        self.assertEqual(self.raw_request(b"GET /v1/jobs/x HTTP/1.1\r\nHost: test\r\n\r\n")[0], 401)
        for token in ["", "  ", "has\nnewline", "not ascii é"]:
            with self.assertRaises(ValueError):
                BridgeHTTPServer(("127.0.0.1", 0), self.service, token)

    def test_malformed_json_and_attachment_validation(self):
        for raw in [b"{", b"null", b"[]", b"NaN", b"\xff", b'{"id":1,"id":2}', b"[" * 1100]:
            with self.subTest(raw=raw[:20]):
                self.assertEqual(self.request(raw=raw)[0], 400)
        for changes in [{"text": "\ud800"}, {"attachments": [{"name": "../x", "mime": "image/png", "base64": "eA=="}]},
                        {"attachments": [{"name": "x", "mime": "image/png", "base64": "!!!!"}]}]:
            self.assertEqual(self.request(value={**job(), **changes})[0], 400)
        for mime in ["text/plain", "application/pdf", "application/zip", "application/octet-stream", "image/svg+xml"]:
            status, payload = self.request(value=job(files=[attachment("file", mime, b"data")]))
            self.assertEqual((status, payload["error"]["code"]), (415, "unsupported_attachment"))

    def test_payload_limits(self):
        self.assertEqual(self.request(raw=b"x" * 2049)[0], 413)
        self.assertEqual(self.request(value=job("x" * 33))[0], 413)
        self.assertEqual(self.request(value=job(files=[attachment("x", "image/png", b"x" * 17)]))[0], 413)
        self.assertEqual(self.request(value=job(files=[attachment(str(n), "image/png", b"x" * 13) for n in range(2)]))[0], 413)
        self.assertEqual(self.request(value=job(files=[attachment(str(n), "image/png", b"x") for n in range(3)]))[0], 413)

    def test_http_framing_media_type_and_timeout(self):
        prefix = f"POST /v1/jobs HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {TOKEN}\r\n".encode()
        for headers, expected in [(b"", 411), (b"Content-Length: -1\r\n", 400),
                                  (b"Content-Length: 3\r\nContent-Length: 3\r\n", 400),
                                  (b"Content-Length: abc\r\n", 400),
                                  (b"Content-Length: 99999999999999999999\r\n", 413),
                                  (b"Transfer-Encoding: chunked\r\n", 400),
                                  (b"Content-Length: 0\r\nContent-Type: text/plain\r\n", 415)]:
            with self.subTest(headers=headers):
                self.assertEqual(self.raw_request(prefix + headers + b"\r\n")[0], expected)
        body_header = b"Content-Length: 20\r\nContent-Type: application/json\r\n\r\n"
        self.assertEqual(self.raw_request(prefix + body_header + b"{}")[0], 400)
        self.assertEqual(self.raw_request(prefix + body_header + b"{}", shutdown=False)[0], 408)
        duplicate_auth = prefix + f"Authorization: Bearer {TOKEN}\r\n".encode() + b"Content-Length: 0\r\n\r\n"
        self.assertEqual(self.raw_request(duplicate_auth)[0], 401)


if __name__ == "__main__":
    unittest.main()
