"""Offline native admission/recovery evidence; shared fake also serves TS tests."""

from __future__ import annotations

from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
from uuid import uuid4

from hermes_bridge import BridgeError, GatewayRunner, JobService
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
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="gateway-test-", dir="/tmp/opencode")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.gateway = self.enterContext(FakeGateway())

    def service(self, **kwargs):
        service = JobService(self.root, self.gateway.runner(), **kwargs)
        self.addCleanup(service.close)
        return service

    def test_durable_intent_lost_202_and_uuid_conflict_never_repost(self):
        value = job()
        checkpoints = []

        def checkpoint_on_wire(raw):
            # Read via a different connection: intent must be committed before POST.
            with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db:
                checkpoints.append(db.execute(
                    "SELECT job_id,body,scope,session_id,first_sent,run_id FROM gateway_runs"
                ).fetchone())

        self.gateway.on_post = checkpoint_on_wire
        self.gateway.post_reply = None
        service = self.service()
        service.submit(value)
        result = wait_done(service, value["id"])
        self.assertEqual(result["error"]["code"], "gateway_outcome_unknown")
        self.assertEqual(len(checkpoints), 1)
        row = checkpoints[0]
        self.assertEqual(row[:4], (value["id"], self.gateway.posts()[0][3], service.runner.scope,
                                   "opencode-" + value["threadId"]))
        self.assertGreater(row[4], 0)
        self.assertLessEqual(row[4], time.time())
        self.assertIsNone(row[5])
        self.assertEqual(json.loads(row[1]), {"input": "hello", "session_id": row[3]})
        service.close()

        service = self.service()
        self.assertEqual(service.submit(value), value["id"])
        with self.assertRaises(BridgeError) as conflict:
            service.submit({**value, "text": "execute something different"})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(service.get(value["id"]), result)
        service.close()
        self.assertEqual([call[0] for call in self.gateway.calls], ["POST"])
        self.assertEqual(self.gateway.posts()[0][2]["Idempotency-Key"], value["id"])
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)
            self.assertNotIn(SECRET, "\n".join(db.iterdump()))

    def test_known_run_resumes_get_only_and_migrates_scope(self):
        self.gateway.get_reply = (200, {"run_id": RUN_ID, "status": "running"})
        service = self.service()
        value = job(files=[attachment("pixel.png", "image/png", PNG)])
        service.submit(value)
        self.assertTrue(self.gateway.get_seen.wait(2))
        started = time.monotonic()
        service.close()
        self.assertLess(time.monotonic() - started, 1)
        # One known receipt and one unsent queue entry from a pre-scope DB.
        service = self.service(autostart=False)
        unsent = job("unscoped pending")
        service.submit(unsent)
        service.close()
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db, db:
            receipt = db.execute("SELECT run_id,body,scope,first_sent FROM gateway_runs").fetchone()
            self.assertEqual(receipt[0], RUN_ID)
            db.execute("ALTER TABLE jobs DROP COLUMN gateway_scope")
        replies = iter(((503, {"error": SECRET}),
                        (200, {"run_id": RUN_ID, "status": "completed", "output": "resumed", **SUCCESS_FLAGS})))
        self.gateway.get_reply = lambda _: next(replies)
        before = len(self.gateway.calls)
        service = self.service()
        self.assertEqual(wait_done(service, value["id"])["text"], "resumed")
        self.assertEqual(service.get(unsent["id"])["error"]["code"], "gateway_outcome_unknown")
        self.assertEqual(service.submit(value), value["id"])
        self.assertEqual(service.submit(unsent), unsent["id"])
        service.close()
        self.assertEqual([(call[0], call[1]) for call in self.gateway.calls[before:]],
                         [("GET", "/v1/runs/" + RUN_ID)] * 2)
        self.assertEqual(len(self.gateway.posts()), 1)
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT run_id,body,scope,first_sent FROM gateway_runs").fetchone(), receipt)
            self.assertIsNone(db.execute("SELECT gateway_scope FROM jobs WHERE id=?", (unsent["id"],)).fetchone()[0])

    def test_legacy_pending_is_quarantined_without_losing_history(self):
        service = self.service(autostart=False)
        pending, completed = job("legacy pending"), job("legacy done")
        service.submit(pending)
        service.submit(completed)
        service.close()
        with closing(sqlite3.connect(self.root / "bridge.sqlite3")) as db, db:
            db.execute("DROP TABLE metadata")
            db.execute("DROP TABLE gateway_runs")
            db.execute("UPDATE jobs SET status='running' WHERE id=?", (pending["id"],))
            db.execute("UPDATE jobs SET status='completed',text='old answer' WHERE id=?", (completed["id"],))
        service = self.service()
        self.assertEqual(service.get(pending["id"])["error"]["code"], "backend_changed")
        self.assertEqual(service.get(completed["id"])["text"], "old answer")
        self.assertEqual(service.submit(pending), pending["id"])
        new = job("new backend")
        service.submit(new)
        self.assertEqual(wait_done(service, new["id"])["status"], "completed")
        self.assertEqual([call[2]["Idempotency-Key"] for call in self.gateway.posts()], [new["id"]])


if __name__ == "__main__":
    unittest.main()
