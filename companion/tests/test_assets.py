"""Asset lifecycle and native-run authority; full plugin E2E lives in TS tests."""

import hashlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.parse import quote
from uuid import uuid4

from hermes_bridge import BridgeError, GatewayRunner, JobService
from hermes_bridge.assets import MAX_ASSET_BYTES, MAX_ASSETS, metadata
from hermes_bridge.core import wire_json
from hermes_bridge.server import BridgeHTTPServer
from test_companion import job, wait_done
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
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="assets-test-", dir="/tmp/opencode")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def serve(self, runner=None):
        service = JobService(self.root, runner or GatewayRunner("http://127.0.0.1:1", SECRET),
                             autostart=False, files_enabled=True)
        self.addCleanup(service.close)
        http = HTTP(service)
        self.addCleanup(http.close)
        return service, http

    def test_upload_recovery_seal_limits_and_expiry_preserve_job(self):
        service, http = self.serve()
        value, incoming = job(), asset()
        path = f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}"
        # Bound allocation before reading the body, and bound retained asset count.
        self.assertEqual(http.request("PUT", path, body=b"", descriptor=incoming,
                                      headers={"Content-Length": str(MAX_ASSET_BYTES + 1)})[0], 413)
        quota_job = str(uuid4())
        for _ in range(MAX_ASSETS):
            service.assets.put(quota_job, asset(b"x"), io.BytesIO(b"x"))
        with self.assertRaises(BridgeError) as quota:
            service.assets.put(quota_job, asset(b"x"), io.BytesIO(b"x"))
        self.assertEqual(quota.exception.status, 413)

        with self.assertRaises(BridgeError):
            service.assets.put(value["id"], incoming, io.BytesIO(ZIP[:-1]))
        self.assertEqual(http.request("GET", path)[0], 409)
        self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[:2], (201, incoming))
        value["input_assets"] = [incoming["asset_id"]]
        service.submit(value)
        self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[0], 200)
        changed = asset(ZIP + b"changed", asset_id=incoming["asset_id"])
        self.assertEqual(http.request("PUT", path, body=ZIP + b"changed", descriptor=changed)[0], 409)
        status, raw, headers = http.request("GET", path)
        self.assertEqual((status, raw), (200, ZIP))
        self.assertEqual((int(headers["Content-Length"]), headers["X-Content-SHA256"]),
                         (len(ZIP), hashlib.sha256(ZIP).hexdigest()))
        original = service.get(value["id"])
        service.assets.expire(time.time() + 86401)
        self.assertEqual(service.get(value["id"]), original)
        self.assertEqual(service.submit(value), value["id"])
        self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[0], 410)
        self.assertFalse(list((self.root / "artifacts").iterdir()))

    def test_native_receipt_binds_file_authority_and_terminal_outputs(self):
        gateway = self.enterContext(FakeGateway())
        gateway.get_reply = (200, {"run_id": RUN_ID, "status": "running"})
        service, http = self.serve(gateway.runner())
        value, incoming, outgoing = job("file task"), asset(), asset(ZIP + b"output", "result.zip")
        path = f"/v1/jobs/{value['id']}/assets/{incoming['asset_id']}"
        internal = f"/internal/runs/{RUN_ID}/assets"
        self.assertEqual(http.request("GET", "/v1/capabilities", token=PRIVATE)[0], 401)
        self.assertEqual(http.request("GET", internal)[0], 401)
        self.assertEqual(http.request("GET", internal, token=PRIVATE)[0], 404)
        self.assertEqual(http.request("PUT", path, body=ZIP, descriptor=incoming)[0], 201)
        self.assertEqual(http.request("POST", "/v1/jobs", value={**job(), "input_assets": [incoming["asset_id"]]})[0], 409)
        value["input_assets"] = [incoming["asset_id"]]
        self.assertEqual(http.request("POST", "/v1/jobs", value=value)[0], 202)
        service.start()
        self.assertTrue(gateway.get_seen.wait(2))  # Real POST/202, not a forged checkpoint.
        self.assertEqual(http.request("GET", internal, token=PRIVATE)[:2],
                         (200, {"job_id": value["id"], "input_assets": [incoming]}))
        self.assertEqual(http.request("GET", internal + "/" + incoming["asset_id"], token=PRIVATE)[:2], (200, ZIP))
        original_runner = service.runner
        service.runner = GatewayRunner(gateway.url, "rotated-test-scope")
        try:
            self.assertEqual(http.request("GET", internal, token=PRIVATE)[0], 409)
        finally:
            service.runner = original_runner
        output_path = internal + "/" + outgoing["asset_id"]
        self.assertEqual(http.request("PUT", output_path, token=PRIVATE,
                                      body=ZIP + b"output", descriptor=outgoing)[:2], (201, outgoing))
        public_output = f"/v1/jobs/{value['id']}/assets/{outgoing['asset_id']}"
        self.assertEqual(http.request("GET", public_output)[0], 409)
        gateway.get_reply = (200, {"run_id": RUN_ID, "status": "completed", "output": "Done", **SUCCESS_FLAGS})
        result = wait_done(service, value["id"])
        self.assertEqual(result["output_assets"], [outgoing])
        self.assertEqual(http.request("GET", public_output)[:2], (200, ZIP + b"output"))
        self.assertEqual(http.request("PUT", output_path, token=PRIVATE,
                                      body=ZIP + b"output", descriptor=outgoing)[0], 409)
        self.assertEqual(service.get(value["id"]), result)
        self.assertEqual(len(gateway.posts()), 1)


if __name__ == "__main__":
    unittest.main()
