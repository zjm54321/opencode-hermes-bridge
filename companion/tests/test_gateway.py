"""Three offline contract/recovery groups; all Gateway traffic is loopback fake HTTP."""

from __future__ import annotations

from contextlib import closing, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

from hermes_bridge import BridgeError, GatewayRunner, HermesRunner, JobService
from hermes_bridge.core import wire_json
from test_companion import PNG, attachment, job, wait_done


SECRET = "fake-gateway-token-never-export"
RUN_ID = "run_" + uuid4().hex
SUCCESS_FLAGS = {"completed": True, "partial": False, "interrupted": False}


class FakeGateway:
    def __init__(self):
        self.calls = []
        self.post_reply = (202, {"run_id": RUN_ID, "status": "started", "replayed": False})
        self.get_reply = (200, {"run_id": RUN_ID, "status": "completed", "output": "safe answer", **SUCCESS_FLAGS})
        self.on_post = None
        self.get_seen = threading.Event()
        self.post_seen = threading.Event()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.handle_call()

            def do_GET(self):
                self.handle_call()

            def handle_call(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                fixture.calls.append((self.command, self.path, dict(self.headers), raw))
                if self.command == "POST":
                    if fixture.on_post:
                        fixture.on_post(raw)
                    fixture.post_seen.set()
                    reply = fixture.post_reply
                else:
                    fixture.get_seen.set()
                    reply = fixture.get_reply
                if callable(reply):
                    reply = reply(self)
                if reply is None:  # Accepted upstream, but its 202 was lost.
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.close_connection = True
                    return
                status, value = reply
                body = value if isinstance(value, bytes) else wire_json(value)
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    if 300 <= status < 400:
                        self.send_header("Location", fixture.url + "/credential-trap")
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, ValueError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def runner(self, **kwargs):
        return GatewayRunner(self.url, SECRET, timeout=0.3, poll_interval=0.01, **kwargs)

    def posts(self):
        return [call for call in self.calls if call[0] == "POST"]


class GatewayTests(unittest.TestCase):
    def service(self, root, runner, **kwargs):
        service = JobService(root, runner, **kwargs)
        self.addCleanup(service.close)
        return service

    def assert_private(self, root, result):
        self.assertNotIn(SECRET, json.dumps(result))
        with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
            self.assertNotIn(SECRET, "\n".join(db.iterdump()))
        for path in Path(root).glob("bridge.sqlite3*"):
            self.assertNotIn(SECRET.encode(), path.read_bytes())

    def test_native_input_session_terminals_and_safety(self):
        self.assertIs(HermesRunner, GatewayRunner)
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            seen_checkpoints = []
            def checkpoint_on_wire(raw):
                with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                    row = db.execute("SELECT job_id,body,scope,session_id,first_sent,run_id FROM gateway_runs ORDER BY first_sent DESC LIMIT 1").fetchone()
                seen_checkpoints.append(row)
                self.assertEqual(row[1], raw)
                self.assertTrue(row[2])
                self.assertLessEqual(row[4], time.time())
                self.assertIsNone(row[5])
            gateway.on_post = checkpoint_on_wire
            with patch.dict(os.environ, {"HERMES_HOME": "/must/not/be/read", "HERMES_MODEL": "must-not-route",
                                         "HERMES_BRIDGE_PROVIDER": "must-not-route", "HERMES_BRIDGE_TOKEN": "different-token"}):
                service = self.service(root, gateway.runner(), autostart=False)
                first = job("text input")
                with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db, db:
                    db.execute("INSERT INTO threads VALUES(?,?)", (first["threadId"], '[{"role":"system","content":"legacy secret history"}]'))
                service.submit(first)
                service.start()
                self.assertEqual(wait_done(service, first["id"])["text"], "safe answer")
                states = iter(("queued", "running", "waiting_for_approval", "stopping", "completed"))
                gateway.get_reply = lambda _: (200, {"run_id": RUN_ID, "status": next(states), "output": "safe image answer", **SUCCESS_FLAGS})
                images = [attachment(f"image{n}", mime, PNG) for n, mime in enumerate(
                    ("image/png", "image/jpeg", "image/gif", "image/webp"))]
                second = job("image input", thread=first["threadId"], files=images)
                service.submit(second)
                self.assertEqual(wait_done(service, second["id"])["text"], "safe image answer")
            posts = gateway.posts()
            bodies = [json.loads(call[3]) for call in posts]
            self.assertEqual(bodies[0], {"input": "text input", "session_id": "opencode-" + first["threadId"]})
            self.assertEqual(bodies[1], {"input": [{"role": "user", "content": [
                {"type": "text", "text": "image input"}, *[{"type": "image_url", "image_url": {
                    "url": f"data:{item['mime']};base64,{item['base64']}"}} for item in images]]}],
                "session_id": bodies[0]["session_id"]})
            self.assertEqual([row[0] for row in seen_checkpoints], [first["id"], second["id"]])
            self.assertEqual([call[2]["Idempotency-Key"] for call in posts], [first["id"], second["id"]])
            self.assertTrue(all(call[2]["Authorization"] == "Bearer " + SECRET for call in gateway.calls))
            self.assertTrue(all(call[1].startswith("/v1/runs") for call in gateway.calls))
            self.assertEqual(list((Path(root) / "jobs").iterdir()), [])
            self.assert_private(root, service.get(second["id"]))
            # Native serialized-body cap includes data URLs and JSON overhead.
            before = len(gateway.posts())
            large = job(files=[attachment("large.png", "image/png", b"x" * 7_500_000)])
            service.submit(large)
            self.assertEqual(wait_done(service, large["id"])["error"]["code"], "payload_too_large")
            self.assertEqual(len(gateway.posts()), before)
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                self.assertIsNone(db.execute("SELECT 1 FROM gateway_runs WHERE job_id=?", (large["id"],)).fetchone())
            service.close()

        cases = [({"status": state, "output": SECRET}, "gateway_incomplete")
                 for state in ("failed", "cancelled", "interrupted")]
        cases += [({"status": "completed", "output": SECRET, **flag}, "gateway_incomplete") for flag in (
            {"completed": False}, {"partial": True}, {"interrupted": True}, {"failed": True},
            {"error": SECRET}, {"error": {"message": SECRET}}, {"error": ""})]
        cases += [({"status": "completed", "output": output}, "invalid_result") for output in (None, [], {})]
        cases += [({"status": "completed", "output": "MEDIA:/original/profile/private.png"}, "unsupported_output"),
                  ({"status": "mystery", "output": SECRET}, "gateway_outcome_unknown"),
                  ({"status": "started", "output": SECRET}, "gateway_outcome_unknown"),
                  ({"status": [], "output": SECRET}, "gateway_outcome_unknown"),
                  ({"status": "completed", "completed": 0, "output": SECRET}, "invalid_result")]
        with FakeGateway() as gateway:
            for payload, expected in cases:
                with self.subTest(payload=payload), tempfile.TemporaryDirectory() as root:
                    gateway.get_reply = (200, {"run_id": RUN_ID, **SUCCESS_FLAGS, **payload})
                    service = self.service(root, gateway.runner())
                    value = job()
                    service.submit(value)
                    output, errors = io.StringIO(), io.StringIO()
                    with redirect_stdout(output), redirect_stderr(errors):
                        result = wait_done(service, value["id"])
                    self.assertEqual((result["status"], result["error"]["code"], result["text"], result["attachments"]),
                                     ("failed", expected, "", []))
                    self.assert_private(root, result)
                    self.assertNotIn(SECRET, output.getvalue() + errors.getvalue())
                    service.close()
            for missing in SUCCESS_FLAGS:
                with self.subTest(missing_terminal_flag=missing), tempfile.TemporaryDirectory() as root:
                    payload = {"run_id": RUN_ID, "status": "completed", "output": SECRET, **SUCCESS_FLAGS}
                    del payload[missing]
                    gateway.get_reply = (200, payload)
                    service = self.service(root, gateway.runner())
                    value = job()
                    service.submit(value)
                    result = wait_done(service, value["id"])
                    self.assertEqual(result["error"]["code"], "invalid_result")
                    self.assertEqual((result["text"], result["attachments"]), ("", []))
                    self.assert_private(root, result)
                    service.close()
            # Protocol errors, redirects, hard timeout and body bounds are fixed errors.
            def malformed_status(handler):
                handler.connection.sendall(b"BAD " + SECRET.encode() + b"\r\n\r\n")
                return None
            for method, reply, limit in [
                ("POST", (302, {"error": SECRET}), 1000),
                ("POST", (202, {"status": "started"}), 1000),
                ("POST", (202, {"run_id": RUN_ID, "status": [], "replayed": False}), 1000),
                ("POST", (202, {"run_id": RUN_ID, "status": "started", "replayed": "false"}), 1000),
                ("POST", (202, {"run_id": "../../" + SECRET, "status": "started"}), 1000),
                ("GET", (404, {"error": SECRET}), 1000),
                ("GET", (307, {"error": SECRET}), 1000),
                ("GET", (200, {"run_id": "run_" + "0" * 32, "status": "completed", "output": SECRET}), 1000),
                ("GET", (200, b'{"status":"completed","status":"running"}'), 1000),
                ("GET", (200, b"x" * 1001), 1000),
                ("GET", (200, b"NaN"), 1000),
                ("GET", malformed_status, 1000),
            ]:
                with self.subTest(method=method, reply=reply), tempfile.TemporaryDirectory() as root:
                    gateway.post_reply = (202, {"run_id": RUN_ID, "status": "started", "replayed": False})
                    gateway.get_reply = (200, {"run_id": RUN_ID, "status": "completed", "output": "answer", **SUCCESS_FLAGS})
                    setattr(gateway, "post_reply" if method == "POST" else "get_reply", reply)
                    start = len(gateway.calls)
                    service = self.service(root, gateway.runner(response_limit=limit))
                    value = job()
                    service.submit(value)
                    result = wait_done(service, value["id"])
                    self.assertEqual(result["error"]["code"], "gateway_outcome_unknown")
                    self.assertTrue(all("credential-trap" not in call[1] for call in gateway.calls[start:]))
                    self.assert_private(root, result)
                    service.close()

        for url in ("", "ftp://example.invalid", "/v1", "http:///v1", "http://",
                    f"http://user:{SECRET}@example.invalid", f"http://example.invalid?key={SECRET}",
                    "http://example.invalid?", "http://example.invalid#", "http://[broken", "http://host:bad",
                    "http://host:", "http://[::1]suffix",
                    "http://host:65536", "http://host/white space", "http://host/\n", "http://host/\x7f", "http://host/\x85"):
            with self.subTest(url=url), self.assertRaises(ValueError) as context:
                GatewayRunner(url, SECRET)
            self.assertNotIn(SECRET, str(context.exception))
        for token in ("", "has space", "has\nnewline", "é"):
            with self.subTest(token=token), self.assertRaises(ValueError):
                GatewayRunner("http://127.0.0.1", token)
        with patch.dict(os.environ, {"HERMES_GATEWAY_URL": "http://127.0.0.1", "HERMES_GATEWAY_TOKEN": SECRET}, clear=True):
            self.assertEqual(GatewayRunner().scope, GatewayRunner("http://127.0.0.1/", SECRET).scope)
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            runner = gateway.runner()
            del runner.scope
            with self.assertRaisesRegex(ValueError, "backend scope"):
                JobService(Path(root) / "missing-scope", runner)
            self.assertFalse((Path(root) / "missing-scope").exists())
            self.assertEqual(gateway.calls, [])

    def test_lost_acceptance_restart_duplicate_and_scope_never_repost(self):
        # Admission binds even unsent queue entries to their original scope.
        # Neither a restart nor an identical duplicate request may rebind them.
        for changed in ("token", "target", "live_runner"):
            with self.subTest(queued_scope_change=changed), tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
                service = self.service(root, gateway.runner(), autostart=False)
                original_scope = service.runner.scope
                value = job()
                service.submit(value)
                replacement = (GatewayRunner(gateway.url, "rotated-token") if changed != "target"
                               else GatewayRunner(gateway.url + "/new-target", SECRET))
                if changed == "live_runner":
                    service.runner = replacement
                else:
                    service.close()
                    service = self.service(root, replacement, autostart=False)
                self.assertEqual(service.submit(value), value["id"])
                with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                    self.assertEqual(db.execute("SELECT gateway_scope FROM jobs WHERE id=?", (value["id"],)).fetchone()[0], original_scope)
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM gateway_runs").fetchone()[0], 0)
                service.start()
                self.assertEqual(wait_done(service, value["id"])["error"]["code"], "gateway_outcome_unknown")
                self.assertEqual(gateway.calls, [])
                self.assert_private(root, service.get(value["id"]))
                service.close()

        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            gateway.post_reply = None
            service = self.service(root, gateway.runner())
            value = job()
            service.submit(value)
            self.assertEqual(wait_done(service, value["id"])["error"]["code"], "gateway_outcome_unknown")
            self.assertEqual(service.submit(value), value["id"])
            service.close()
            for runner in (gateway.runner(), GatewayRunner(gateway.url, "rotated-fake-token"),
                           GatewayRunner(gateway.url + "/changed-target", SECRET)):
                service = self.service(root, runner)
                self.assertEqual(service.submit(value), value["id"])
                self.assertEqual(service.get(value["id"])["error"]["code"], "gateway_outcome_unknown")
                service.close()
            self.assertEqual(len(gateway.posts()), 1)
            self.assertEqual(gateway.posts()[0][2]["Idempotency-Key"], value["id"])
            self.assert_private(root, service.runner.scope)

        # Simulate abrupt death after the synchronous intent commit, before 202.
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            service = self.service(root, gateway.runner(), autostart=False)
            value = job()
            service.submit(value)
            request = service._request(value)
            body = wire_json({"input": value["text"], "session_id": "opencode-" + value["threadId"]})
            record, fresh = request.checkpoint.prepare(body, service.runner.scope, "opencode-" + value["threadId"])
            self.assertTrue(fresh)
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db, db:
                db.execute("UPDATE jobs SET status='running' WHERE id=?", (value["id"],))
            service.close()
            service = self.service(root, gateway.runner())
            self.assertEqual(service.get(value["id"])["error"]["code"], "gateway_outcome_unknown")
            self.assertEqual(service.submit(value), value["id"])
            self.assertEqual(gateway.posts(), [])
            service.close()

        # Known IDs cannot be polled under a different credential OR target scope.
        for changed in ("token", "target"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
                gateway.get_reply = (200, {"run_id": RUN_ID, "status": "running"})
                service = self.service(root, gateway.runner())
                value = job()
                service.submit(value)
                self.assertTrue(gateway.get_seen.wait(2))
                service.close()
                before = len(gateway.calls)
                runner = GatewayRunner(gateway.url, "rotated-token") if changed == "token" else GatewayRunner(gateway.url + "/new-target", SECRET)
                service = self.service(root, runner)
                self.assertEqual(wait_done(service, value["id"])["error"]["code"], "gateway_outcome_unknown")
                self.assertEqual(len(gateway.calls), before)
                self.assertEqual(len(gateway.posts()), 1)
                service.close()

    def test_known_run_get_only_resume_and_legacy_backend_quarantine(self):
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            gateway.get_reply = (200, {"run_id": RUN_ID, "status": "running"})
            service = self.service(root, gateway.runner())
            value = job(files=[attachment("same.png", "image/png", PNG)])
            service.submit(value)
            self.assertTrue(gateway.get_seen.wait(2))
            before_close = time.monotonic()
            service.close()
            self.assertLess(time.monotonic() - before_close, 1)
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                row = db.execute("SELECT run_id,body,scope,first_sent FROM gateway_runs WHERE job_id=?", (value["id"],)).fetchone()
                self.assertEqual(row[0], RUN_ID)
                self.assertEqual(db.execute("SELECT status FROM jobs").fetchone()[0], "running")
            replies = iter(((503, {"error": SECRET}), (429, {"error": SECRET}), None,
                            (503, {"error": SECRET}),
                            (200, {"run_id": RUN_ID, "status": "completed", "output": "resumed", **SUCCESS_FLAGS})))
            gateway.get_reply = lambda _: next(replies)
            count = len(gateway.calls)
            service = self.service(root, gateway.runner())
            self.assertEqual(wait_done(service, value["id"])["text"], "resumed")
            self.assertEqual(len(gateway.posts()), 1)
            self.assertEqual(len(gateway.calls[count:]), 5)
            self.assertTrue(all(call[0] == "GET" for call in gateway.calls[count:]))
            self.assertFalse(any(call[1].endswith("/stop") for call in gateway.calls))
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                self.assertEqual(db.execute("SELECT run_id,body,scope,first_sent FROM gateway_runs WHERE job_id=?", (value["id"],)).fetchone(), row)
            self.assertEqual(service.submit(value), value["id"])
            service.close()

        # Persistent transient failures keep the job resumable and never POST
        # again. Even during retry backoff, close stops local waiting promptly.
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            retried = threading.Event()
            attempts = 0
            def unavailable(_):
                nonlocal attempts
                attempts += 1
                if attempts >= 4:
                    retried.set()
                return (503, {"error": SECRET})
            gateway.get_reply = unavailable
            service = self.service(root, gateway.runner())
            value = job()
            service.submit(value)
            self.assertTrue(retried.wait(2))
            self.assertEqual(service.get(value["id"])["status"], "running")
            start = time.monotonic()
            service.close()
            self.assertLess(time.monotonic() - start, 1)
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                self.assertEqual(db.execute("SELECT status,error FROM jobs").fetchone(), ("running", None))
                self.assertEqual(db.execute("SELECT run_id FROM gateway_runs").fetchone()[0], RUN_ID)
            self.assertEqual(len(gateway.posts()), 1)
            gateway.get_reply = (200, {"run_id": RUN_ID, "status": "completed", "output": "recovered", **SUCCESS_FLAGS})
            service = self.service(root, gateway.runner())
            self.assertEqual(wait_done(service, value["id"])["text"], "recovered")
            self.assertEqual(len(gateway.posts()), 1)
            service.close()

        # A pre-column Gateway DB can recover a scope from a durable send record,
        # but must quarantine an unscoped/unsent pending job instead of binding it.
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            service = self.service(root, gateway.runner(), autostart=False)
            unsent, known = job("unscoped unsent"), job("known scope")
            service.submit(unsent)
            service.submit(known)
            request = service._request(known)
            session_id = "opencode-" + known["threadId"]
            request.checkpoint.prepare(wire_json({"input": known["text"], "session_id": session_id}),
                                       service.runner.scope, session_id)
            request.checkpoint.accepted(RUN_ID)
            service.close()
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db, db:
                db.execute("UPDATE jobs SET status='running' WHERE id=?", (known["id"],))
                db.execute("ALTER TABLE jobs DROP COLUMN gateway_scope")
            service = self.service(root, gateway.runner())
            self.assertEqual(service.get(unsent["id"])["error"]["code"], "gateway_outcome_unknown")
            self.assertEqual(wait_done(service, known["id"])["status"], "completed")
            self.assertTrue(gateway.calls)
            self.assertTrue(all(call[0] == "GET" for call in gateway.calls))
            self.assertEqual(service.submit(unsent), unsent["id"])
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                self.assertIsNone(db.execute("SELECT gateway_scope FROM jobs WHERE id=?", (unsent["id"],)).fetchone()[0])
            service.close()

        # A peer trickling headers below the inactivity timeout still hits the
        # wall deadline. No second admission is attempted, even after restart.
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            def slow_headers(handler):
                try:
                    handler.connection.sendall(b"HTTP/1.1 202 Accepted\r\nX-Slow: ")
                    for _ in range(20):
                        handler.connection.sendall(b"x")
                        time.sleep(0.05)
                except OSError:
                    pass
                return None
            gateway.post_reply = slow_headers
            service = self.service(root, gateway.runner())
            value = job()
            start = time.monotonic()
            service.submit(value)
            self.assertEqual(wait_done(service, value["id"])["error"]["code"], "gateway_outcome_unknown")
            self.assertLess(time.monotonic() - start, 1)
            service.close()
            service = self.service(root, gateway.runner())
            self.assertEqual(service.submit(value), value["id"])
            self.assertEqual(len(gateway.posts()), 1)
            service.close()

        # Slow native headers cannot hold close() open during POST or GET.
        for stage in ("POST", "GET"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
                release = threading.Event()
                self.addCleanup(release.set)
                def stall(handler):
                    release.wait(2)
                    return None
                setattr(gateway, "post_reply" if stage == "POST" else "get_reply", stall)
                service = self.service(root, gateway.runner())
                value = job()
                service.submit(value)
                self.assertTrue((gateway.post_seen if stage == "POST" else gateway.get_seen).wait(2))
                start = time.monotonic()
                service.close()
                self.assertLess(time.monotonic() - start, 1)
                release.set()
                with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                    self.assertEqual(db.execute("SELECT status FROM jobs").fetchone()[0], "running")

        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            service = self.service(root, gateway.runner(), autostart=False)
            old_queued, old_running, completed = job("legacy queued"), job("legacy running"), job("legacy done")
            for value in (old_queued, old_running, completed):
                service.submit(value)
            service.close()
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db, db:
                db.execute("DROP TABLE metadata")
                db.execute("DROP TABLE gateway_runs")
                db.execute("UPDATE jobs SET status='running' WHERE id=?", (old_running["id"],))
                db.execute("UPDATE jobs SET status='completed',text='old answer' WHERE id=?", (completed["id"],))
            service = self.service(root, gateway.runner(), autostart=False)
            for value in (old_queued, old_running):
                self.assertEqual(service.get(value["id"])["error"]["code"], "backend_changed")
            self.assertEqual(service.get(completed["id"])["text"], "old answer")
            new_queued = job("new queued")
            service.submit(new_queued)
            service.close()
            service = self.service(root, gateway.runner())
            self.assertEqual(wait_done(service, new_queued["id"])["status"], "completed")
            self.assertEqual(len(gateway.posts()), 1)
            self.assertEqual(gateway.posts()[0][2]["Idempotency-Key"], new_queued["id"])
            service.close()


if __name__ == "__main__":
    unittest.main()
