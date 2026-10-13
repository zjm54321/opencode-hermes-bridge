"""Three offline groups for opaque asset transfer, isolation, and recovery."""
from contextlib import closing
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from urllib.parse import quote
from uuid import uuid4

from hermes_bridge import BridgeError, GatewayRunner, JobService, RunResult
from hermes_bridge.assets import MAX_ASSET_BYTES, metadata
from hermes_bridge.core import wire_json
from hermes_bridge.server import BridgeHandler, BridgeHTTPServer
from test_companion import FunctionRunner, job, wait_done
from test_gateway import FakeGateway, RUN_ID, SECRET, SUCCESS_FLAGS

PUBLIC = "test-public-assets-token"
PRIVATE = "test-private-files-token"
ZIP = b"PK\x03\x04\x00\xffopaque archive bytes\x00\x80"


def asset(data=ZIP, name="原 bytes.zip", asset_id=None):
    return metadata(asset_id or str(uuid4()), name, "application/zip", len(data), hashlib.sha256(data).hexdigest())


class HTTP:
    def __init__(self, service, file_token=PRIVATE):
        self.server = BridgeHTTPServer(("127.0.0.1", 0), service, PUBLIC, file_token=file_token, request_timeout=0.3)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, *, body=None, value=None, descriptor=None, token=PUBLIC, headers=None):
        header = {"Authorization": "Bearer " + token}
        if value is not None:
            body = wire_json(value)
            header["Content-Type"] = "application/json"
        if descriptor is not None:
            header.update({"Content-Type": descriptor["mime"], "Content-Length": str(descriptor["size"]),
                           "Content-Disposition": "attachment; filename*=UTF-8''" + quote(descriptor["name"], safe=""),
                           "X-Content-SHA256": descriptor["sha256"]})
        header.update(headers or {})
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path, body=body, headers=header)
            response = connection.getresponse()
            raw = response.read()
            result = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw
            return response.status, result, dict(response.getheaders())
        finally:
            connection.close()


class AssetTests(unittest.TestCase):
    def serve(self, root, runner=None, *, autostart=False):
        service = JobService(root, runner or GatewayRunner("http://127.0.0.1:1", SECRET),
                             autostart=autostart, files_enabled=True)
        http = HTTP(service)
        self.addCleanup(service.close)
        self.addCleanup(http.close)
        return service, http

    def mapped(self, service, value):
        service.submit(value)
        with service._condition, service._db:
            service._db.execute("UPDATE jobs SET status='running' WHERE id=?", (value["id"],))
        checkpoint = service._request(value).checkpoint
        checkpoint.prepare(b'{"input":"fake"}', service.runner.scope, "opencode-" + value["threadId"])
        checkpoint.accepted(RUN_ID)

    def test_zip_input_native_mapping_output_download_and_one_post(self):
        with tempfile.TemporaryDirectory() as root, FakeGateway() as gateway:
            service, http = self.serve(root, gateway.runner())
            value = {**job("round trip ZIP"), "input_assets": []}
            incoming, outgoing = asset(), asset(ZIP + b"\x00output", "result.zip")
            path = f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}"
            self.assertEqual(http.request("GET", "/v1/capabilities")[1], {
                "object": "hermes.bridge.capabilities", "version": 1, "assets": True,
                "max_asset_bytes": 10485760, "max_total_asset_bytes": 20971520, "max_assets": 8})
            self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[:2], (201, incoming))
            self.assertEqual(gateway.posts(), [])
            value["input_assets"] = [incoming["asset_id"]]
            internal = f"/internal/runs/{RUN_ID}/assets"
            seen = []
            def complete(_):
                seen.append(http.request("GET", internal, token=PRIVATE)[:2])
                seen.append(http.request("GET", internal + "/" + incoming["asset_id"], token=PRIVATE)[:2])
                seen.append(http.request("PUT", internal + "/" + outgoing["asset_id"], token=PRIVATE,
                                         descriptor=outgoing, body=ZIP + b"\x00output")[:2])
                seen.append(http.request("GET", f"/v1/jobs/{value['id']}/assets/{outgoing['asset_id']}")[0])
                return 200, {"run_id": RUN_ID, "status": "completed", "output": "Done\nMEDIA:/never/read/or/parse.zip", **SUCCESS_FLAGS}
            gateway.get_reply = complete
            self.assertEqual(http.request("POST", "/v1/jobs", value=value)[0], 202)
            service.start()
            result = wait_done(service, value["id"])
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["output_assets"], [outgoing])
            self.assertEqual(seen, [(200, {"job_id": value["id"], "input_assets": [incoming]}),
                                    (200, ZIP), (201, outgoing), 409])
            status, raw, headers = http.request("GET", f"/v1/jobs/{value['id']}/assets/{outgoing['asset_id']}")
            self.assertEqual((status, raw), (200, ZIP + b"\x00output"))
            self.assertEqual(headers["X-Content-SHA256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(len(gateway.posts()), 1)
            self.assertEqual(service.submit(value), value["id"])
            wire = json.loads(gateway.posts()[0][3])
            self.assertEqual(set(wire), {"input", "session_id"})
            self.assertIn("bridge_files", wire["input"])
            self.assertIn("bridge_publish_file", wire["input"])
            self.assertNotIn(PRIVATE, json.dumps(wire))
            self.assertEqual(http.request("PUT", internal + "/" + outgoing["asset_id"], token=PRIVATE,
                                          descriptor=outgoing, body=ZIP + b"\x00output")[0], 409)
            with closing(sqlite3.connect(Path(root) / "bridge.sqlite3")) as db:
                dumped = "\n".join(db.iterdump())
                self.assertNotIn(PRIVATE, dumped)
                self.assertNotIn(PUBLIC, dumped)
            http.close(); self._cleanups.pop()
            service.close(); self._cleanups.pop()

    def test_auth_binding_scope_paths_headers_and_quotas(self):
        with tempfile.TemporaryDirectory() as root:
            service, http = self.serve(root)
            value = {**job(), "input_assets": []}
            incoming = asset()
            path = f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}"
            self.assertEqual(http.request("GET", "/v1/capabilities", token=PRIVATE)[0], 401)
            self.assertEqual(http.request("GET", f"/internal/runs/{RUN_ID}/assets")[0], 401)
            self.assertEqual(http.request("GET", f"/internal/runs/{RUN_ID}/assets", token=PRIVATE)[0], 404)
            # Actual peer address governs access; forwarded headers cannot upgrade it.
            handler = object.__new__(BridgeHandler)
            handler.server, handler.client_address = http.server, ("192.168.1.8", 1234)
            from email.message import Message
            handler.headers = Message()
            handler.headers["Authorization"] = "Bearer " + PRIVATE
            handler.headers["X-Forwarded-For"] = "127.0.0.1"
            with self.assertRaises(BridgeError) as error:
                handler._auth(True)
            self.assertEqual(error.exception.status, 403)
            for extra in ({"Content-Disposition": "attachment; filename*=UTF-8''..%2Fx"},
                          {"Content-Disposition": "attachment; filename*=UTF-8''bad%ZZ"},
                          {"Content-Type": "application/zip; x=y"}, {"X-Content-SHA256": "A" * 64},
                          {"Transfer-Encoding": "chunked"}):
                self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming, headers=extra)[0], 400)
            self.assertEqual(http.request("PUT", path, body=b"", descriptor=incoming,
                                          headers={"Content-Length": str(MAX_ASSET_BYTES + 1)})[0], 413)
            self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[0], 201)
            self.assertEqual(http.request("GET", f"/v1/jobs/{uuid4()}/assets/{incoming['asset_id']}")[0], 404)
            self.assertEqual(http.request("POST", "/v1/jobs", value={**job(), "input_assets": [incoming["asset_id"]]})[0], 409)
            value["input_assets"] = [incoming["asset_id"]]
            self.mapped(service, value)
            self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[0], 200)
            extra = asset()
            self.assertEqual(http.request("PUT", f"/v1/jobs/{value['id']}/assets/{extra['asset_id']}", body=ZIP, descriptor=extra)[0], 409)
            old_runner = service.runner
            service.runner = GatewayRunner("http://127.0.0.1:1", "rotated-gateway-scope")
            self.assertEqual(http.request("GET", f"/internal/runs/{RUN_ID}/assets", token=PRIVATE)[0], 409)
            self.assertEqual(http.request("GET", path)[0], 409)
            service.runner = old_runner
            quota_job = str(uuid4())
            for _ in range(8):
                descriptor = asset(b"x")
                service.assets.put(quota_job, descriptor, io.BytesIO(b"x"))
            with self.assertRaises(BridgeError) as error:
                service.assets.put(quota_job, asset(b"x"), io.BytesIO(b"x"))
            self.assertEqual(error.exception.status, 413)
            large_job = str(uuid4())
            data = b"z" * MAX_ASSET_BYTES
            for _ in range(2):
                service.assets.put(large_job, asset(data), io.BytesIO(data))
            with self.assertRaises(BridgeError) as error:
                service.assets.put(large_job, asset(b"x"), io.BytesIO(b"x"))
            self.assertEqual(error.exception.status, 413)
            blob = Path(root) / "artifacts" / (incoming["asset_id"] + ".blob")
            blob.unlink(); blob.symlink_to(Path(root) / "bridge.sqlite3")
            self.assertEqual(http.request("GET", path)[0], 410)
            with self.assertRaises(ValueError):
                BridgeHTTPServer(("127.0.0.1", 0), service, PUBLIC, file_token=PUBLIC)
            http.close(); self._cleanups.pop()
            http = HTTP(service, file_token="")
            self.addCleanup(http.close)
            self.assertFalse(http.request("GET", "/v1/capabilities")[1]["assets"])
            self.assertEqual(http.request("POST", "/v1/jobs", value={**job(), "input_assets": []})[0], 415)
            http.close(); self._cleanups.pop()
            service.close(); self._cleanups.pop()

    def test_interruption_concurrent_seal_terminal_freeze_and_expiry(self):
        with tempfile.TemporaryDirectory() as root:
            service, http = self.serve(root)
            value, incoming = {**job(), "input_assets": []}, asset()
            with self.assertRaises(BridgeError):
                service.assets.put(value["id"], incoming, io.BytesIO(ZIP[:-1]))
            with self.assertRaises(BridgeError) as error:
                service.assets.get(value["id"], incoming["asset_id"])
            self.assertEqual(error.exception.status, 409)
            # Emulate a crash after fsync/seal but before SQLite commit.
            orphan = Path(root) / "artifacts" / (incoming["asset_id"] + ".blob")
            orphan.write_bytes(ZIP); orphan.chmod(0o600)
            http.close(); self._cleanups.pop()
            service.close(); self._cleanups.pop()
            service, http = self.serve(root)
            self.assertFalse(orphan.exists())
            statuses = []
            def put():
                statuses.append(http.request("PUT", f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}",
                                             body=ZIP, descriptor=incoming)[0])
            workers = [threading.Thread(target=put) for _ in range(4)]
            for worker in workers: worker.start()
            for worker in workers: worker.join()
            self.assertEqual(sorted(statuses), [200, 200, 200, 201])
            changed = {**incoming, "name": "different.zip"}
            self.assertEqual(http.request("PUT", f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}",
                                          body=ZIP, descriptor=changed)[0], 409)
            value["input_assets"] = [incoming["asset_id"]]
            service.submit(value)
            original_job = service.get(value["id"])
            self.assertEqual(service.assets.expire(time.time() + 86401), 1)
            self.assertEqual(service.get(value["id"]), original_job)
            self.assertEqual(service.submit(value), value["id"])
            self.assertFalse(orphan.exists())
            self.assertEqual(http.request("PUT", f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}",
                                          body=ZIP, descriptor=incoming)[0], 410)
            http.close(); self._cleanups.pop()
            service.close(); self._cleanups.pop()
            service, http = self.serve(root)
            self.assertEqual(http.request("GET", f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}")[0], 410)
            http.close(); self._cleanups.pop()
            service.close(); self._cleanups.pop()

        with tempfile.TemporaryDirectory() as root:
            ready, complete, reading, release = (threading.Event() for _ in range(4))
            def run(request):
                request.checkpoint.prepare(b'{"input":"fake"}', runner.scope, "opencode-" + request.thread_id)
                request.checkpoint.accepted(RUN_ID)
                ready.set()
                complete.wait(3)
                return RunResult("plain completed text")
            runner = FunctionRunner(run)
            service, http = self.serve(root, runner)
            value = {**job(), "input_assets": []}
            service.submit(value); service.start()
            self.assertTrue(ready.wait(2))
            class Slow(io.BytesIO):
                def read(self, size=-1):
                    reading.set()
                    release.wait(3)
                    return super().read(size)
            outcome = []
            outgoing = asset()
            def late():
                try:
                    service.assets.put_output(RUN_ID, outgoing, Slow(ZIP))
                except BridgeError as error:
                    outcome.append(error.status)
            worker = threading.Thread(target=late); worker.start()
            self.assertTrue(reading.wait(2))
            complete.set()
            self.assertEqual(wait_done(service, value["id"])["output_assets"], [])
            release.set(); worker.join()
            self.assertEqual(outcome, [409])
            self.assertFalse((Path(root) / "artifacts" / (outgoing["asset_id"] + ".blob")).exists())
            http.close(); self._cleanups.pop()
            service.close(); self._cleanups.pop()


if __name__ == "__main__":
    unittest.main()
