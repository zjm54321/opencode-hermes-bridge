from __future__ import annotations

import base64
from contextlib import closing, redirect_stderr, redirect_stdout
import hashlib
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

from hermes_bridge import BridgeError, JobService, Limits, RunInput, RunResult
from hermes_bridge.core import normalize_job, read_output, wire_json
from hermes_bridge.runner import HermesRunner
from hermes_bridge.server import BridgeHTTPServer, main
from http_fixture import EchoRunner


TOKEN = "test-token-not-production"
ROUTE = {"HERMES_BRIDGE_PROVIDER": "custom",
         "HERMES_BRIDGE_BASE_URL": "http://aether.ai-services.svc.cluster.local:8084/v1",
         "HERMES_BRIDGE_API_MODE": "chat_completions"}
MODEL_KEY = "sentinel-model-key-never-export"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==")
FILES = [("pixel.png", "image/png", PNG), ("hello world.txt", "text/plain", "真实 bytes\n".encode()),
         ("bundle.zip", "application/zip", b"PK\x05\x06" + b"\x00" * 18),
         ("paper.pdf", "application/pdf", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n%%EOF\n")]


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

    def test_bytes_images_history_and_immutable_poll(self):
        seen = []
        def run(request):
            seen.append(request)
            return EchoRunner().run(request)
        service = self.service(FunctionRunner(run))
        first = job(files=[attachment(*item) for item in FILES])
        service.submit(first)
        result = wait_done(service, first["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["text"], "hello")
        for (_, _, data), output in zip(FILES, result["attachments"]):
            self.assertEqual(hashlib.sha256(data).digest(), hashlib.sha256(base64.b64decode(output["base64"])).digest())
        image_parts = [p for p in seen[0].user_message if p["type"] == "image_url"]
        self.assertEqual(image_parts, [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(PNG).decode()}}])
        self.assertEqual([p.read_bytes() for p in seen[0].uploads], [f[2] for f in FILES])
        for path in seen[0].output_dir.iterdir():
            path.write_bytes(b"changed later")
        self.assertEqual(service.get(first["id"]), result)
        self.close_service(service)
        service = self.service(FunctionRunner(run))
        self.assertEqual(service.get(first["id"]), result)
        second = job("second", thread=first["threadId"])
        service.submit(second)
        self.assertEqual(wait_done(service, second["id"])["status"], "completed")
        self.assertEqual(seen[1].conversation_history, [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hello"}])

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
        second = job("two", thread=first["threadId"])
        third = job("three", thread=first["threadId"])
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
        self.assertEqual(len(calls[2].conversation_history), 4)
        self.assertEqual(maximum, 1)

    def test_restart_queued_resumes_running_fails_without_replay(self):
        service = self.service(autostart=False)
        interrupted, queued = job("interrupted"), job("queued")
        service.submit(interrupted)
        service.submit(queued)
        # Simulate a process lost after the committed running transition.
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db, db:
            db.execute("UPDATE jobs SET status='running' WHERE id=?", (interrupted["id"],))
        self.close_service(service)
        calls = []
        def run(request):
            calls.append(request.text)
            return EchoRunner().run(request)
        service = self.service(FunctionRunner(run), autostart=False)
        self.assertEqual(service.get(interrupted["id"])["error"]["code"], "restart")
        self.assertEqual(service.get(queued["id"])["status"], "queued")
        service.start()
        self.assertEqual(wait_done(service, queued["id"])["status"], "completed")
        self.assertEqual(calls, ["queued"])
        self.assertEqual(service.submit(interrupted), interrupted["id"])
        self.assertEqual(service.get(interrupted["id"])["status"], "failed")

    def test_runner_exception_redacted_worker_survives(self):
        service = self.service()
        first, second = job("__fixture_fail__"), job("next")
        service.submit(first)
        service.submit(second)
        result = wait_done(service, first["id"])
        self.assertEqual(result["error"]["code"], "execution_failed")
        self.assertNotIn("test-provider-secret", json.dumps(result))
        self.assertEqual(wait_done(service, second["id"])["status"], "completed")

    def test_output_security_and_missing_fail_whole_job(self):
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_bytes(b"private")
        def run(request):
            good = request.output_dir / "good.txt"
            good.write_bytes(b"good")
            kind = request.text
            if kind == "absolute":
                bad = outside
            elif kind == "parent":
                bad = str(request.output_dir / ".." / "outside.txt")
            elif kind == "relative":
                bad = "relative.txt"
            elif kind == "symlink":
                bad = request.output_dir / "link.txt"
                bad.symlink_to(outside)
            elif kind == "directory_symlink":
                parent = request.output_dir / "linkdir"
                parent.symlink_to(outside.parent, target_is_directory=True)
                bad = parent / outside.name
            elif kind == "fifo":
                bad = request.output_dir / "fifo"
                os.mkfifo(bad)
            elif kind == "directory":
                bad = request.output_dir
            elif kind == "url":
                bad = "https://example.invalid/a.png"
            else:
                bad = request.output_dir / "missing.txt"
            return RunResult(f"prefix\nMEDIA:{good}\nMEDIA:{bad}")
        service = self.service(FunctionRunner(run))
        for kind in ["absolute", "parent", "relative", "symlink", "directory_symlink", "fifo", "directory", "url", "missing"]:
            with self.subTest(kind=kind):
                value = job(kind)
                service.submit(value)
                result = wait_done(service, value["id"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], "unsafe_output")
                self.assertEqual((result["text"], result["attachments"]), ("", []))

    def test_nested_output_spaces_and_history_not_exported(self):
        def run(request):
            directory = request.output_dir / "nested"
            directory.mkdir()
            path = directory / "space name.txt"
            path.write_bytes(b"bytes")
            return RunResult(f"answer\n  MEDIA:{path}\n", [{"role": "assistant", "content": "MEDIA:/etc/passwd"}])
        service = self.service(FunctionRunner(run))
        value = job()
        service.submit(value)
        result = wait_done(service, value["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["text"], "answer")
        self.assertEqual(result["attachments"], [attachment("space name.txt", "text/plain", b"bytes")])

    def test_output_file_total_count_text_and_wire_limits(self):
        limits = Limits(body=600, text=20, files=2, file_bytes=10, total_bytes=15)
        def run(request):
            mode = request.text
            if mode == "text":
                return RunResult("x" * 21)
            if mode == "wire":
                return RunResult("x" * 601)
            count, size = {"file": (1, 11), "total": (2, 8), "count": (3, 1)}[mode]
            lines = []
            for n in range(count):
                path = request.output_dir / f"{n}.txt"
                path.write_bytes(b"x" * size)
                lines.append(f"MEDIA:{path}")
            return RunResult("\n".join(lines))
        service = self.service(FunctionRunner(run), limits=limits)
        for mode in ["file", "total", "count", "text", "wire"]:
            with self.subTest(mode=mode):
                value = job(mode)
                service.submit(value)
                result = wait_done(service, value["id"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], "output_too_large")

    def test_private_permissions_and_single_owner(self):
        service = self.service(autostart=False)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / "jobs").stat().st_mode), 0o700)
        for path in self.root.glob("bridge.sqlite3*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaisesRegex(ValueError, "already owned"):
            JobService(self.root, EchoRunner())
        value = job(files=[attachment("file.bin", "application/octet-stream", b"bytes")])
        service.submit(value)
        service.start()
        self.assertEqual(wait_done(service, value["id"])["status"], "completed")
        upload = self.root / "jobs" / value["id"] / "uploads" / "file.bin"
        self.assertEqual(stat.S_IMODE(upload.stat().st_mode), 0o600)

    def test_dedup_normalized_and_conflict(self):
        service = self.service(autostart=False)
        value = job(files=[attachment("a.png", "IMAGE/PNG", PNG)])
        service.submit(value)
        same = json.loads(json.dumps(value))
        same["id"] = same["id"].upper()
        same["threadId"] = same["threadId"].upper()
        same["attachments"][0]["mime"] = "image/png"
        self.assertEqual(service.submit(same), value["id"])
        same["text"] = "different"
        with self.assertRaises(BridgeError) as context:
            service.submit(same)
        self.assertEqual(context.exception.status, 409)
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)


class ValidationTests(unittest.TestCase):
    def test_names_mime_and_strict_base64(self):
        invalid = ["../x", "/absolute", "a/b", "a\\b", "\x00bad", "..", ".", "", "C:drive", "a\nb"]
        for name in invalid:
            with self.subTest(name=name), self.assertRaises(BridgeError):
                normalize_job(job(files=[attachment(name, "text/plain", b"x")]), Limits())
        for mime in ["", "text", "text/plain\r\nx: y", "text/plain; charset=utf-8", "text /plain"]:
            with self.subTest(mime=mime), self.assertRaises(BridgeError):
                normalize_job(job(files=[attachment("x", mime, b"x")]), Limits())
        for encoded in ["!!!!", "Zg", "Zg===", "Zg==\n", "Zh==", "é"]:
            with self.subTest(base64=encoded), self.assertRaises(BridgeError):
                normalize_job(job(files=[{"name": "x", "mime": "text/plain", "base64": encoded}]), Limits())
        with self.assertRaises(BridgeError):
            normalize_job(job(files=[attachment("x", "text/plain", b"a")] * 2), Limits())

    def test_input_limits_and_unicode(self):
        limits = Limits(text=5, files=2, file_bytes=3, total_bytes=5)
        cases = [job("123456"), job("汉字"), job(files=[attachment("x", "text/plain", b"1234")]),
                 job(files=[attachment(str(n), "text/plain", b"123") for n in range(2)]),
                 job(files=[attachment(str(n), "text/plain", b"") for n in range(3)])]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(BridgeError) as context:
                normalize_job(value, limits)
            self.assertEqual(context.exception.status, 413)
        with self.assertRaises(BridgeError):
            normalize_job(job("\ud800"), limits)
        with self.assertRaises(BridgeError):
            normalize_job({**job(), "id": "invalid"}, limits)

    @patch.dict(os.environ, {}, clear=True)
    def test_hermes_public_api_adapter(self):
        calls = {}
        class Agent:
            def __init__(self, **kwargs):
                calls["init"] = kwargs
            def run_conversation(self, **kwargs):
                calls["run"] = kwargs
                return {"final_response": "answer", "messages": [{"role": "assistant", "content": "answer"}]}
        request = RunInput("job", "thread", "text", "text", "system", [], Path("/private/output"), (), ())
        result = HermesRunner("explicit-model", agent_factory=Agent).run(request)
        self.assertEqual(calls["init"], {"session_id": "thread", "model": "explicit-model", "quiet_mode": True})
        self.assertEqual(calls["run"], {"user_message": "text", "system_message": "system", "conversation_history": [], "task_id": "job"})
        self.assertEqual(result.final_response, "answer")
        with patch.dict(os.environ, {"HERMES_MODEL": "environment-model"}):
            HermesRunner(agent_factory=Agent).run(request)
            self.assertEqual(calls["init"], {"session_id": "thread", "model": "environment-model", "quiet_mode": True})
            HermesRunner("override-model", agent_factory=Agent).run(request)
            self.assertEqual(calls["init"]["model"], "override-model")
        with patch.dict(os.environ, {"HERMES_MODEL": ""}):
            with self.assertRaisesRegex(ValueError, "explicit model is required"):
                HermesRunner(agent_factory=Agent)
        with patch.dict(os.environ, {"HERMES_MODEL": "  "}):
            with self.assertRaisesRegex(ValueError, "explicit model is required"):
                HermesRunner(agent_factory=Agent)

    def test_hermes_explicit_route_factory_parameters(self):
        calls = {}
        class Agent:
            def __init__(self, **kwargs):
                calls["init"] = kwargs
            def run_conversation(self, **kwargs):
                calls["run"] = kwargs
                return {"completed": True, "final_response": "answer", "messages": []}
        request = RunInput("job", "thread", "text", "text", "system", [], Path("/private/output"), (), ())
        for custom_key_env in (False, True):
            for base_url in (ROUTE["HERMES_BRIDGE_BASE_URL"], "https://example.invalid/v1/"):
                env = {**ROUTE, "HERMES_BRIDGE_BASE_URL": " " + base_url + " ",
                       "HERMES_BRIDGE_PROVIDER": " custom ", "HERMES_BRIDGE_API_MODE": " chat_completions ",
                       "HERMES_MODEL": " z-ai/glm-5.3-flash "}
                key_env = "CUSTOM_MODEL_KEY" if custom_key_env else "HERMES_BRIDGE_MODEL_API_KEY"
                env[key_env] = MODEL_KEY
                if custom_key_env:
                    env["HERMES_BRIDGE_API_KEY_ENV"] = key_env
                    env["HERMES_BRIDGE_MODEL_API_KEY"] = "unused-default-key"
                with self.subTest(custom_key_env=custom_key_env, base_url=base_url), patch.dict(os.environ, env, clear=True):
                    runner = HermesRunner(agent_factory=Agent)
                    os.environ[key_env] = "changed-after-initialization"
                    result = runner.run(request)
                self.assertEqual(calls["init"], {"session_id": "thread", "model": "z-ai/glm-5.3-flash",
                                              "quiet_mode": True, "provider": "custom", "base_url": base_url,
                                              "api_mode": "chat_completions", "api_key": MODEL_KEY})
                self.assertEqual(calls["run"], {"user_message": "text", "system_message": "system",
                                             "conversation_history": [], "task_id": "job"})
                self.assertNotIn(MODEL_KEY, repr(request))
                self.assertNotIn(MODEL_KEY, repr(result))
                self.assertNotIn(MODEL_KEY, repr(runner._route))

    def test_hermes_route_configuration_fails_fast_and_redacted(self):
        valid = {**ROUTE, "HERMES_BRIDGE_MODEL_API_KEY": MODEL_KEY}
        invalid = []
        for name in ROUTE:
            invalid.append({key: value for key, value in valid.items() if key != name})
            invalid.extend([{**valid, name: ""}, {**valid, name: "  "}, {**valid, name: "bad\nvalue"}])
        invalid.extend([{**valid, "HERMES_BRIDGE_MODEL_API_KEY": ""},
                        {**valid, "HERMES_BRIDGE_MODEL_API_KEY": "  "}, dict(ROUTE),
                        {"HERMES_BRIDGE_API_KEY_ENV": "MODEL_KEY"},
                        {**valid, "HERMES_BRIDGE_API_MODE": "responses"}])
        for name in ("", "1BAD", "BAD-NAME", "A=B", "BAD NAME", "BAD\nNAME", MODEL_KEY, "é"):
            invalid.append({**valid, "HERMES_BRIDGE_API_KEY_ENV": name})
        invalid.append({**valid, "HERMES_BRIDGE_API_KEY_ENV": "UNSET_KEY"})
        for url in ("ftp://example.invalid/v1", "/v1", "http:///v1", "http://",
                    f"http://user:{MODEL_KEY}@example.invalid/v1", f"http://example.invalid/v1?key={MODEL_KEY}",
                    f"http://example.invalid/v1#{MODEL_KEY}", "http://example.invalid/v1?",
                    "http://example.invalid/v1#", "http://[broken/v1", "http://example.invalid:bad/v1",
                    "http://example.invalid:65536/v1", "http://example.invalid/white space",
                    "http://example.invalid/v1\n", "http://example.invalid/\x7f", "http://example.invalid/\x85"):
            invalid.append({**valid, "HERMES_BRIDGE_BASE_URL": url})
        def factory(**kwargs):
            self.fail("Invalid configuration must not invoke the agent factory")
        for index, env in enumerate(invalid):
            with self.subTest(case=index), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(ValueError) as context:
                    HermesRunner("test-model", agent_factory=factory)
                self.assertNotIn(MODEL_KEY, str(context.exception))

    def test_server_route_failure_is_sanitized_before_workspace_or_worker(self):
        env = {**ROUTE, "HERMES_BRIDGE_TOKEN": TOKEN, "HERMES_MODEL": "test-model",
               "HERMES_BRIDGE_MODEL_API_KEY": MODEL_KEY,
               "HERMES_BRIDGE_BASE_URL": f"http://user:{MODEL_KEY}@example.invalid/v1"}
        output = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch("sys.argv", ["companion"]), redirect_stderr(output):
            with patch("hermes_bridge.server.private_directory") as workspace, patch("hermes_bridge.server.JobService") as service:
                with self.assertRaises(SystemExit) as context:
                    main()
                self.assertEqual(context.exception.code, 2)
                workspace.assert_not_called()
                service.assert_not_called()
        self.assertIn("Invalid Hermes model routing configuration", output.getvalue())
        self.assertNotIn(MODEL_KEY, output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())

    def test_hermes_completed_and_legacy_results(self):
        class Agent:
            def __init__(self, **kwargs):
                pass
            def run_conversation(self, **kwargs):
                return payload
        request = RunInput("job", "thread", "text", "text", "system", [], Path("/private/output"), (), ())
        runner = HermesRunner("test-model", agent_factory=Agent)
        for flags in [{}, {"completed": True}, {"completed": True, "failed": False, "partial": False,
                                              "interrupted": False, "error": None}, {"error": ""}]:
            with self.subTest(flags=flags):
                payload = {"final_response": "answer", "messages": [{"role": "assistant", "content": "answer"}], **flags}
                self.assertEqual(runner.run(request), RunResult("answer", payload["messages"]))

    def test_hermes_incomplete_flags_are_redacted(self):
        secret = "fake-provider-credential-do-not-export"
        class Agent:
            def __init__(self, **kwargs):
                pass
            def run_conversation(self, **kwargs):
                return payload
        request = RunInput("job", "thread", "text", "text", "system", [], Path("/private/output"), (), ())
        runner = HermesRunner("test-model", agent_factory=Agent)
        for flags in [{"completed": False}, {"failed": True}, {"partial": True}, {"interrupted": True},
                      {"error": secret}, {"error": {"message": secret}},
                      {"completed": False, "error": secret}, {"completed": True, "failed": True}]:
            with self.subTest(flags=flags):
                payload = {"final_response": secret, "messages": [{"role": "assistant", "content": secret}],
                           "failure_reason": secret, **flags}
                with self.assertRaises(BridgeError) as context:
                    runner.run(request)
                self.assertEqual(context.exception.code, "hermes_incomplete")
                self.assertEqual(str(context.exception), "Hermes did not complete the job.")

    def test_hermes_invalid_structure_is_fixed_error(self):
        secret = "fake-provider-credential-do-not-export"
        class Agent:
            def __init__(self, **kwargs):
                pass
            def run_conversation(self, **kwargs):
                return payload
        request = RunInput("job", "thread", "text", "text", "system", [], Path("/private/output"), (), ())
        runner = HermesRunner("test-model", agent_factory=Agent)
        for payload in [None, secret, [secret], {}, {"final_response": secret},
                        {"final_response": None, "messages": []}, {"final_response": "answer", "messages": secret}]:
            with self.subTest(payload=payload), self.assertRaises(BridgeError) as context:
                runner.run(request)
            self.assertEqual(context.exception.code, "invalid_result")
            self.assertEqual(str(context.exception), "Hermes returned an invalid result.")


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
        raw = b"".join(chunks)
        header, body = raw.split(b"\r\n\r\n", 1)
        return int(header.split(b" ")[1]), json.loads(body)

    def test_202_poll_dedup_conflict_and_unknown(self):
        value = job(files=[attachment("hello.txt", "text/plain", b"hello")])
        status, response = self.request(value=value)
        self.assertEqual((status, response), (202, {"id": value["id"]}))
        self.assertEqual(self.request(value=value)[0], 202)
        with closing(sqlite3.connect(Path(self.temp.name) / "bridge.sqlite3")) as db, db:
            persisted = db.execute("SELECT input FROM jobs WHERE id=?", (value["id"],)).fetchone()
            self.assertEqual(json.loads(persisted[0]), value)
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
        raw = b"GET /v1/jobs/x HTTP/1.1\r\nHost: test\r\n\r\n"
        self.assertEqual(self.raw_request(raw)[0], 401)
        for token in ["", "  ", "has\nnewline", "not ascii é"]:
            with self.assertRaises(ValueError):
                BridgeHTTPServer(("127.0.0.1", 0), self.service, token)

    def test_hermes_returned_failures_never_reach_http_or_database(self):
        secret = "fake-provider-credential-do-not-export"
        failures = {"incomplete": {"completed": False, "error": secret},
                    "failed": {"failed": True}, "partial": {"partial": True},
                    "interrupted": {"interrupted": True}, "error": {"error": {"message": secret}}}
        class Agent:
            def __init__(self, **kwargs):
                pass
            def run_conversation(self, **kwargs):
                mode = kwargs["user_message"]
                if mode in failures:
                    return {"final_response": secret, "messages": [{"role": "assistant", "content": secret}],
                            "failure_reason": secret, **failures[mode]}
                return {"completed": True, "final_response": "safe answer",
                        "messages": [{"role": "assistant", "content": "safe answer"}]}
        self.service.runner = HermesRunner("test-model", agent_factory=Agent)
        self.service.start()
        for mode in failures:
            with self.subTest(mode=mode):
                value = job(mode)
                self.assertEqual(self.request(value=value)[0], 202)
                result = wait_done(self.service, value["id"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"], {"code": "hermes_incomplete", "message": "Hermes did not complete the job."})
                self.assertEqual((result["text"], result["attachments"]), ("", []))
                status, polled = self.request("GET", "/v1/jobs/" + value["id"])
                self.assertEqual(status, 200)
                self.assertEqual(polled, result)
                self.assertNotIn(secret, json.dumps(polled))
        with closing(sqlite3.connect(Path(self.temp.name) / "bridge.sqlite3")) as db:
            self.assertNotIn(secret, "\n".join(db.iterdump()))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM threads").fetchone()[0], 0)
        healthy = job("healthy")
        self.assertEqual(self.request(value=healthy)[0], 202)
        self.assertEqual(wait_done(self.service, healthy["id"])["status"], "completed")

    def test_explicit_route_secret_stays_out_of_http_history_database_and_logs(self):
        calls = []
        class Agent:
            def __init__(self, **kwargs):
                self.api_key = kwargs["api_key"]
            def run_conversation(self, **kwargs):
                calls.append(kwargs)
                if kwargs["user_message"] == "raise":
                    raise RuntimeError(self.api_key)
                if kwargs["user_message"] == "incomplete":
                    return {"completed": False, "error": self.api_key, "final_response": self.api_key,
                            "messages": [{"role": "assistant", "content": self.api_key}]}
                return {"completed": True, "final_response": "safe answer",
                        "messages": [{"role": "assistant", "content": "safe answer"}]}
        with patch.dict(os.environ, {**ROUTE, "HERMES_BRIDGE_MODEL_API_KEY": MODEL_KEY}, clear=True):
            self.service.runner = HermesRunner("test-model", agent_factory=Agent)
        output, errors = io.StringIO(), io.StringIO()
        thread = str(uuid4())
        with redirect_stdout(output), redirect_stderr(errors), self.assertNoLogs():
            self.service.start()
            for mode, expected in (("raise", "execution_failed"), ("incomplete", "hermes_incomplete"),
                                   ("healthy", None), ("followup", None)):
                value = job(mode, thread=thread)
                status, submitted = self.request(value=value)
                self.assertEqual(status, 202)
                self.assertNotIn(MODEL_KEY, json.dumps(submitted))
                result = wait_done(self.service, value["id"])
                self.assertEqual(result["status"], "failed" if expected else "completed")
                if expected:
                    self.assertEqual(result["error"]["code"], expected)
                status, polled = self.request("GET", "/v1/jobs/" + value["id"])
                self.assertEqual((status, polled), (200, result))
                self.assertNotIn(MODEL_KEY, json.dumps(polled))
            with closing(sqlite3.connect(Path(self.temp.name) / "bridge.sqlite3")) as db:
                self.assertNotIn(MODEL_KEY, "\n".join(db.iterdump()))
            for path in Path(self.temp.name).rglob("*"):
                if path.is_file():
                    self.assertNotIn(MODEL_KEY.encode(), path.read_bytes())
        self.assertTrue(calls[-1]["conversation_history"])
        self.assertNotIn(MODEL_KEY, json.dumps(calls))
        self.assertNotIn(MODEL_KEY, output.getvalue() + errors.getvalue())

    def test_malformed_json_and_attachment_validation(self):
        for raw in [b"{", b"null", b"[]", b"NaN", b"\xff", b'{"id":1,"id":2}', b"[" * 1100]:
            with self.subTest(raw=raw[:20]):
                self.assertEqual(self.request(raw=raw)[0], 400)
        for changes in [{"text": "\ud800"}, {"attachments": [{"name": "../x", "mime": "text/plain", "base64": "eA=="}]},
                        {"attachments": [{"name": "x", "mime": "text/plain", "base64": "!!!!"}]}]:
            self.assertEqual(self.request(value={**job(), **changes})[0], 400)

    def test_payload_limits(self):
        self.assertEqual(self.request(raw=b"x" * 2049)[0], 413)
        self.assertEqual(self.request(value=job("x" * 33))[0], 413)
        self.assertEqual(self.request(value=job(files=[attachment("x", "text/plain", b"x" * 17)]))[0], 413)
        self.assertEqual(self.request(value=job(files=[attachment(str(n), "text/plain", b"x" * 13) for n in range(2)]))[0], 413)
        self.assertEqual(self.request(value=job(files=[attachment(str(n), "text/plain", b"x") for n in range(3)]))[0], 413)

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
