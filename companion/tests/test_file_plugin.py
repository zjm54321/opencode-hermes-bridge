"""Standalone file plugin: original bytes, trusted workspace, transfer integrity.

The local HTTP peer is a fixture, not a model or a deployed Hermes instance.
"""

import contextvars
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import types
import unittest
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import quote, unquote


PLUGIN_PARENT = Path(__file__).resolve().parents[2] / "integrations"
sys.path.insert(0, str(PLUGIN_PARENT))
try:
    plugin = importlib.import_module("hermes_file_plugin")
finally:
    sys.path.remove(str(PLUGIN_PARENT))

RUN = "run_" + "1" * 32
OTHER_RUN = "run_" + "2" * 32
JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
INPUT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TOKEN = "independent-file-only-test-token"


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, name, handler, **kwargs):
        self.tools[name] = handler


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        for key, value in (headers or {"Content-Type": "application/json"}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        self.server.fixture.requests.append((self.command, self.path))
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.reply(401, {})
            return False
        if not self.path.startswith("/internal/runs/" + RUN + "/assets"):
            self.reply(403, {})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        fixture = self.server.fixture
        if self.path.endswith("/assets"):
            self.reply(200, {"job_id": JOB, "input_assets": fixture.assets})
        elif self.path.endswith("/" + INPUT_ID):
            asset = fixture.assets[0]
            data = fixture.data
            if fixture.corrupt:
                data = bytes([data[0] ^ 1]) + data[1:]
            self.reply(200, data, {
                "Content-Type": asset["mime"],
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(asset["name"], safe=""),
                "X-Content-SHA256": fixture.header_hash or asset["sha256"],
            })
        else:
            self.reply(404, {})

    def do_PUT(self):
        if not self.authorized():
            return
        fixture = self.server.fixture
        data = self.rfile.read(int(self.headers["Content-Length"]))
        digest = hashlib.sha256(data).hexdigest()
        disposition = self.headers["Content-Disposition"]
        if not disposition.startswith("attachment; filename*=UTF-8''") or digest != self.headers["X-Content-SHA256"]:
            self.reply(400, {})
            return
        metadata = {"asset_id": str(uuid.UUID(self.path.rsplit("/", 1)[-1])),
                    "name": unquote(disposition.split("''", 1)[1]), "mime": self.headers["Content-Type"],
                    "size": len(data), "sha256": digest}
        fixture.puts.append((self.path, metadata, data))
        if fixture.drop_put_response:
            fixture.drop_put_response = False
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        self.reply(201, {**metadata, "sha256": "0" * 64} if fixture.bad_ack else metadata)


class FilePluginTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="file-plugin-", dir="/tmp/opencode")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "private"
        self.root.mkdir(mode=0o700)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("original.bin", b"\x00\xfforiginal ZIP bytes\x00")
            z.writestr("../do-not-extract.txt", b"ZIPs are opaque")
        self.data = archive.getvalue()
        self.assets = [{"asset_id": INPUT_ID, "name": "原件 archive.zip", "mime": "application/zip",
                        "size": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest()}]
        self.requests, self.puts = [], []
        self.corrupt = self.drop_put_response = self.bad_ack = False
        self.header_hash = None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        self.server.fixture = self
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.enterContext(patch.dict(os.environ, {
            "HERMES_BRIDGE_FILES_LOCAL": "1", "HERMES_BRIDGE_FILE_ROOT": str(self.root),
            "HERMES_BRIDGE_FILE_TOKEN": TOKEN,
            "HERMES_BRIDGE_FILES_URL": "http://127.0.0.1:" + str(self.server.server_port),
        }))
        self.context = contextvars.ContextVar("_approval_session_key", default="")
        approval = types.ModuleType("tools.approval_context")
        approval._approval_session_key = self.context
        self.enterContext(patch.dict(sys.modules, {
            "tools": types.ModuleType("tools"), "tools.approval_context": approval,
        }))
        self.context.set(RUN)
        self.registry = Registry()
        plugin.register(self.registry)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, name="bridge_files", args=None, **kwargs):
        response = self.registry.tools[name]({} if args is None else args, **kwargs)
        self.assertNotIn(TOKEN, response)
        return json.loads(response)

    def test_original_zip_and_retry_stable_publication(self):
        result = self.call(task_id=OTHER_RUN, session_id=OTHER_RUN)
        workspace = Path(result["workspace"])
        self.assertEqual(workspace, self.root / RUN)
        source = Path(result["input_assets"][0]["path"])
        self.assertEqual(source.read_bytes(), self.data)
        self.assertFalse(list(self.root.rglob("*.bin")))
        self.assertFalse(list(self.root.rglob("do-not-extract.txt")))
        output = workspace / "unchanged.zip"
        output.write_bytes(source.read_bytes())  # Ordinary local tool, not archive extraction.
        args = {"path": output.name, "name": "发布.zip", "mime": "application/zip"}
        self.drop_put_response = True
        self.assertIn("error", self.call("bridge_publish_file", args))
        published = self.call("bridge_publish_file", args)
        self.assertEqual((published["size"], published["sha256"]),
                         (len(self.data), hashlib.sha256(self.data).hexdigest()))
        self.assertEqual(len(self.puts), 2)
        self.assertEqual(self.puts[0], self.puts[1])
        self.assertEqual(self.puts[1][1:], (published, self.data))
        self.assertEqual({method for method, _ in self.requests}, {"GET", "PUT"})

    def test_trusted_context_and_workspace_escape_rejection(self):
        self.context.set("")
        with patch.dict(os.environ, {"HERMES_RUN_ID": RUN}):
            self.assertIn("error", self.call(task_id=RUN, session_id=RUN))
        self.context.set(RUN)
        self.assertIn("error", self.call(args={"run_id": OTHER_RUN}))
        self.assertEqual(self.requests, [])
        self.assertEqual(list(self.root.iterdir()), [])
        self.context.set(OTHER_RUN)
        self.assertIn("error", self.call("bridge_publish_file", {"path": "secret"}))
        self.assertFalse((self.root / OTHER_RUN).exists())
        self.context.set(RUN)
        incoming, self.assets = self.assets, []
        workspace = Path(self.call()["workspace"])
        outside = self.root / OTHER_RUN
        outside.mkdir(mode=0o700)
        secret = outside / "secret.txt"
        secret.write_bytes(b"not-this-run")
        (workspace / "linked").symlink_to(secret)
        (workspace / "linked-dir").symlink_to(outside, target_is_directory=True)
        os.mkfifo(workspace / "fifo")
        for path in (str(secret), "../" + OTHER_RUN + "/secret.txt", "linked", "linked-dir/secret.txt", "fifo"):
            with self.subTest(path=path):
                self.assertIn("error", self.call("bridge_publish_file", {"path": path}))
        self.assertEqual(self.puts, [])
        self.assets = incoming
        (workspace / "inputs").symlink_to(outside, target_is_directory=True)
        self.assertIn("error", self.call())
        self.assertEqual(list(outside.iterdir()), [secret])
        self.assertEqual(secret.read_bytes(), b"not-this-run")

    def test_download_and_publication_integrity_fail_closed(self):
        # A matching header cannot hide corrupt bytes; a wrong header cannot be ignored.
        for problem in ("corrupt", "header_hash"):
            with self.subTest(problem=problem):
                setattr(self, problem, "0" * 64 if problem == "header_hash" else True)
                self.assertIn("error", self.call())
                self.assertEqual(list((self.root / RUN).rglob("*")), [])
                setattr(self, problem, None if problem == "header_hash" else False)
        imported = self.call()["input_assets"][0]
        self.bad_ack = True
        self.assertIn("error", self.call("bridge_publish_file", {"path": imported["path"]}))
        self.assertEqual(self.puts[0][2], self.data)
        self.assertEqual(Path(imported["path"]).read_bytes(), self.data)


if __name__ == "__main__":
    unittest.main()
