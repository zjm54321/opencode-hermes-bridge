"""Real local filesystem/HTTP evidence for the standalone Hermes file plugin.

No Hermes import, model, production service, or companion implementation needed.
Run: python -m unittest discover -s companion/tests -p test_file_plugin.py -v
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
import time
import types
import unittest
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import quote


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
        self.availability = {}

    def register_tool(self, name, toolset, schema, handler, check_fn=None,
                      requires_env=None, is_async=False, description=""):
        assert schema["name"] == name
        assert schema["description"] == description
        assert schema["parameters"]["additionalProperties"] is False
        assert toolset == "bridge_files"
        assert not is_async
        assert requires_env == ["HERMES_BRIDGE_FILES_LOCAL", "HERMES_BRIDGE_FILE_ROOT", "HERMES_BRIDGE_FILE_TOKEN"]
        assert callable(check_fn)
        self.tools[name] = handler
        self.availability[name] = check_fn


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _begin(self):
        fixture = self.server.fixture
        fixture.requests.append((self.command, self.path))
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._begin():
            return
        fixture = self.server.fixture
        base = "/internal/runs/" + RUN + "/assets"
        if self.path == base:
            fixture.list_attempts += 1
            if fixture.list_attempts <= fixture.registration_404s:
                self._json(404, {"error": "not registered yet"})
            elif fixture.list_status != 200:
                if fixture.list_status == 302:
                    self.send_response(302)
                    self.send_header("Location", "http://192.0.2.1/never-follow")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._json(fixture.list_status, {"error": "opaque upstream secret"})
            else:
                self._json(200, {"job_id": JOB, "input_assets": fixture.assets})
        elif self.path == base + "/" + INPUT_ID:
            asset = fixture.assets[0]
            self.send_response(200)
            self.send_header("Content-Type", asset["mime"])
            self.send_header("Content-Length", str(asset["size"]))
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(asset["name"], safe=""))
            self.send_header("X-Content-SHA256", fixture.header_hash or asset["sha256"])
            self.end_headers()
            data = fixture.data
            if fixture.corrupt:
                data = bytes([data[0] ^ 1]) + data[1:]
            if fixture.truncate:
                self.wfile.write(data[:len(data) // 2])
                self.wfile.flush()
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_WR)
            else:
                self.wfile.write(data)
        else:
            self._json(404, {"error": "wrong run or asset"})

    def do_PUT(self):
        if not self._begin():
            return
        fixture = self.server.fixture
        asset_id = self.path.rsplit("/", 1)[-1]
        data = self.rfile.read(int(self.headers["Content-Length"]))
        # The fixture independently checks the wire contract and stores raw bytes.
        from urllib.parse import unquote
        disposition = self.headers["Content-Disposition"]
        if not disposition.startswith("attachment; filename*=UTF-8''"):
            self._json(400, {"error": "disposition"})
            return
        name = unquote(disposition.split("''", 1)[1], encoding="utf-8", errors="strict")
        digest = hashlib.sha256(data).hexdigest()
        if digest != self.headers["X-Content-SHA256"]:
            self._json(400, {"error": "hash"})
            return
        metadata = {"asset_id": str(uuid.UUID(asset_id)), "name": name,
                    "mime": self.headers["Content-Type"], "size": len(data), "sha256": digest}
        existing = asset_id in fixture.outputs
        fixture.puts.append((self.path, dict(self.headers), data))
        fixture.outputs[asset_id] = (metadata, data)
        if fixture.drop_put_response:
            fixture.drop_put_response = False
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        self._json(200 if existing else 201, metadata)

    def do_POST(self):
        self.server.fixture.requests.append((self.command, self.path))
        self._json(405, {"error": "never submit jobs"})


class FilePluginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="file-plugin-", dir="/tmp/opencode")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private"
        self.root.mkdir(mode=0o700)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("original.bin", b"\x00\xfforiginal ZIP bytes\x00")
            z.writestr("../do-not-extract.txt", b"ZIPs are opaque")
        self.data = archive.getvalue()
        self.assets = [{"asset_id": INPUT_ID, "name": "原件 archive.zip", "mime": "application/zip",
                        "size": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest()}]
        self.requests, self.puts, self.outputs = [], [], {}
        self.registration_404s = self.list_attempts = 0
        self.list_status = 200
        self.corrupt = self.truncate = self.drop_put_response = False
        self.header_hash = None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        self.server.daemon_threads = True
        self.server.fixture = self
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)
        self.env = patch.dict(os.environ, {
            "HERMES_BRIDGE_FILES_LOCAL": "1", "HERMES_BRIDGE_FILE_ROOT": str(self.root),
            "HERMES_BRIDGE_FILE_TOKEN": TOKEN,
            "HERMES_BRIDGE_FILES_URL": "http://127.0.0.1:" + str(self.server.server_port),
            "HTTP_PROXY": "http://192.0.2.1:9999", "HTTPS_PROXY": "http://192.0.2.1:9999",
            "ALL_PROXY": "http://192.0.2.1:9999", "NO_PROXY": "",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.context = contextvars.ContextVar("_approval_session_key", default="")
        tools = types.ModuleType("tools")
        approval = types.ModuleType("tools.approval_context")
        approval._approval_session_key = self.context
        self.modules = patch.dict(sys.modules, {"tools": tools, "tools.approval_context": approval})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.context.set(RUN)
        self.registry = Registry()
        plugin.register(self.registry)
        self.assertEqual(set(self.registry.tools), {"bridge_files", "bridge_publish_file"})
        self.assertEqual(self.requests, [])
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertTrue(all(check() for check in self.registry.availability.values()))

    def _stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, name="bridge_files", args=None, **kwargs):
        response = self.registry.tools[name]({} if args is None else args, **kwargs)
        self.assertIsInstance(response, str)
        self.assertNotIn(TOKEN, response)
        self.assertNotIn("opaque upstream secret", response)
        return json.loads(response)

    def workspace(self):
        self.assets = []
        result = self.call()
        self.assertNotIn("error", result)
        return Path(result["workspace"])

    # Group 1: original bytes, ordinary local paths, and retry-stable publication.
    def test_zip_import_publish_same_hash_and_stable_id_after_lost_response(self):
        result = self.call(task_id="irrelevant", session_id="irrelevant")
        self.assertNotIn("error", result)
        workspace = Path(result["workspace"])
        self.assertEqual(workspace, self.root / RUN)
        self.assertEqual(workspace.stat().st_mode & 0o777, 0o700)
        item = result["input_assets"][0]
        source = Path(item["path"])
        self.assertEqual(source.read_bytes(), self.data)
        self.assertEqual(source.stat().st_mode & 0o777, 0o600)
        self.assertFalse((workspace / "do-not-extract.txt").exists())
        inode = source.stat().st_ino
        self.assertNotIn("error", self.call())
        self.assertEqual(source.stat().st_ino, inode)
        output = workspace / "unchanged.zip"
        output.write_bytes(source.read_bytes())  # A normal local tool's operation.
        args = {"path": "unchanged.zip", "name": "发布.zip", "mime": "application/zip"}
        self.drop_put_response = True
        self.assertIn("error", self.call("bridge_publish_file", args))
        published = self.call("bridge_publish_file", args)
        self.assertEqual(set(published), {"asset_id", "name", "mime", "size", "sha256"})
        self.assertEqual(published["sha256"], item["sha256"])
        self.assertEqual(published["size"], len(self.data))
        self.assertEqual(len(self.outputs), 1)
        self.assertEqual(self.puts[0][0], self.puts[1][0])
        self.assertEqual(self.puts[1][2], self.data)
        repeated = self.call("bridge_publish_file", {**args, "path": str(output)})
        self.assertEqual(published, repeated)
        self.assertEqual(self.outputs[published["asset_id"]][1], self.data)
        self.assertFalse(list(workspace.rglob(".bridge-*")))
        self.assertEqual(list(workspace.rglob("*.bin")), [])

    def test_empty_run_and_copied_thread_context(self):
        self.assets = []
        responses = []
        context = contextvars.copy_context()
        thread = threading.Thread(target=lambda: responses.append(context.run(self.call)))
        thread.start()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(responses[0]["input_assets"], [])
        self.assertTrue(Path(responses[0]["workspace"]).is_dir())

    # Group 2: authority, local-only configuration, and descriptor/path boundaries.
    def test_missing_or_forged_context_never_uses_task_session_or_env(self):
        for value in ("", None, "run_fake", OTHER_RUN + "/../" + RUN, "run_" + "g" * 32):
            with self.subTest(context=value):
                self.context.set(value)
                with patch.dict(os.environ, {"HERMES_RUN_ID": RUN, "HERMES_SESSION_ID": RUN}):
                    self.assertIn("error", self.call(task_id=RUN, session_id=RUN))
                    self.assertIn("error", self.call(args={"run_id": RUN}))
        self.context.set(RUN)
        for args in ({"run_id": OTHER_RUN}, {"task_id": RUN}, {"path": "/opt/data"}, {"url": "http://192.0.2.1"}):
            self.assertIn("error", self.call(args=args))
        with patch.dict(sys.modules, {"tools.approval_context": None}):
            self.assertIn("error", self.call())
        approval = sys.modules["tools.approval_context"]
        with patch.object(approval, "_approval_session_key", types.SimpleNamespace(get=lambda: RUN)):
            self.assertIn("error", self.call())
        self.assertEqual(self.requests, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_rejects_nonlocal_or_incomplete_configuration_without_http(self):
        changes = [
            {"HERMES_BRIDGE_FILES_LOCAL": ""}, {"HERMES_BRIDGE_FILES_LOCAL": "true"},
            {"HERMES_BRIDGE_FILE_ROOT": ""}, {"HERMES_BRIDGE_FILE_ROOT": "relative"},
            {"HERMES_BRIDGE_FILE_TOKEN": ""}, {"HERMES_BRIDGE_FILE_TOKEN": "bad\r\ntoken"},
        ]
        origins = ["https://example.com", "http://192.0.2.1", "http://127.0.0.1/",
                   "http://127.0.0.1/path", "http://127.0.0.1?x=1", "http://127.0.0.1#x",
                   "http://user@127.0.0.1", "http://127.0.0.1?", "http://127.0.0.1#",
                   "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://127.0.0.1\n"]
        changes += [{"HERMES_BRIDGE_FILES_URL": value} for value in origins]
        for change in changes:
            with self.subTest(change=change), patch.dict(os.environ, change):
                self.assertIn("error", self.call())
                if (os.environ.get("HERMES_BRIDGE_FILES_LOCAL") != "1"
                        or not os.environ.get("HERMES_BRIDGE_FILE_ROOT")
                        or not os.environ.get("HERMES_BRIDGE_FILE_TOKEN")):
                    self.assertFalse(any(check() for check in self.registry.availability.values()))
        self.assertEqual(self.requests, [])
        self.root.chmod(0o755)
        self.assertIn("error", self.call())
        self.root.chmod(0o700)
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with patch.dict(os.environ, {"HERMES_BRIDGE_FILE_ROOT": str(alias)}):
            self.assertIn("error", self.call())
        # Valid configuration now authorizes before any filesystem inspection.
        self.assertEqual(len(self.requests), 2)
        self.assertEqual({method for method, _ in self.requests}, {"GET"})
        self.assertFalse((self.root / RUN).exists())

    def test_cross_workspace_symlink_hardlink_special_and_escape_rejected(self):
        workspace = self.workspace()
        other = self.root / OTHER_RUN
        other.mkdir(mode=0o700)
        secret = other / "secret.txt"
        secret.write_bytes(b"not-this-run")
        (workspace / "linked").symlink_to(secret)
        (workspace / "linked-dir").symlink_to(other, target_is_directory=True)
        os.link(secret, workspace / "hardlinked")
        (workspace / "directory").mkdir()
        os.mkfifo(workspace / "fifo")
        oversized = workspace / "oversized"
        with oversized.open("wb") as stream:
            stream.truncate(10 * 1024 * 1024 + 1)
        paths = [str(secret), "../" + OTHER_RUN + "/secret.txt", "/opt/data/secret.txt",
                 "linked", "linked-dir/secret.txt", "hardlinked", "directory", "fifo", "oversized",
                 "", ".", "../../secret", "a/../secret", "//etc/passwd"]
        for path in paths:
            with self.subTest(path=path):
                self.assertIn("error", self.call("bridge_publish_file", {"path": path}))
        self.assertEqual(self.puts, [])
        self.assertEqual(secret.read_bytes(), b"not-this-run")
        self.assertEqual(len(self.requests), 1 + len(paths))
        self.assertEqual({method for method, _ in self.requests}, {"GET"})

    def test_download_does_not_follow_symlinks_or_replace_different_bytes(self):
        original = self.assets[:]
        workspace = self.workspace()
        self.assets = original
        outside = self.root / OTHER_RUN
        outside.mkdir(mode=0o700)
        (workspace / "inputs").symlink_to(outside, target_is_directory=True)
        self.assertIn("error", self.call())
        self.assertEqual(list(outside.iterdir()), [])
        (workspace / "inputs").unlink()
        first = self.call()
        path = Path(first["input_assets"][0]["path"])
        path.write_bytes(b"existing different bytes")
        self.assertIn("error", self.call())
        self.assertEqual(path.read_bytes(), b"existing different bytes")
        path.unlink()
        target = outside / "untouched"
        target.write_bytes(b"outside")
        path.symlink_to(target)
        self.assertIn("error", self.call())
        self.assertEqual(target.read_bytes(), b"outside")
        self.assertFalse(list(workspace.rglob(".bridge-*")))

    # Group 3: bounded GET-only registration retry and no corrupt/partial delivery.
    def test_both_tools_authorize_before_workspace_or_snapshot_and_wait_for_registration(self):
        self.assets = []
        self.registration_404s = 10000
        workspace = self.root / RUN
        for tool, args in (("bridge_files", {}), ("bridge_publish_file", {"path": "output.zip"})):
            with self.subTest(tool=tool), patch.object(plugin.client.os, "open", wraps=os.open) as opens:
                started = time.monotonic()
                result = self.call(tool, args)
                elapsed = time.monotonic() - started
                self.assertEqual(result, {"error": "Run is not registered for file access."})
                self.assertGreater(elapsed, 4.5)
                self.assertLessEqual(elapsed, 5.0)
                opens.assert_not_called()
                self.assertFalse(workspace.exists())
                self.assertEqual(self.puts, [])
        self.assertEqual({method for method, _ in self.requests}, {"GET"})

        # Delayed registration allows the first tool to create its empty workspace.
        self.registration_404s = self.list_attempts + 2
        before = self.list_attempts
        self.assertEqual(self.call(), {"workspace": str(workspace), "input_assets": []})
        self.assertEqual(self.list_attempts, before + 3)
        output = workspace / "output.zip"
        output.write_bytes(self.data)

        # A later denied scope must not even open an existing output for reading.
        self.list_status = 403
        with patch.object(plugin.client.os, "open", wraps=os.open) as opens:
            self.assertIn("error", self.call("bridge_publish_file", {"path": "output.zip"}))
            opens.assert_not_called()
        self.assertEqual(output.read_bytes(), self.data)
        self.assertEqual(self.puts, [])

        # Publication uses the same GET-only wait, then exactly one PUT.
        self.list_status = 200
        self.registration_404s = self.list_attempts + 2
        before = len(self.requests)
        published = self.call("bridge_publish_file", {"path": "output.zip", "mime": "application/zip"})
        self.assertNotIn("error", published)
        self.assertEqual([method for method, _ in self.requests[before:]], ["GET", "GET", "GET", "PUT"])
        self.assertEqual(self.outputs[published["asset_id"]][1], self.data)

    def test_registration_delay_retries_get_only_and_has_five_second_budget(self):
        self.assets = []
        self.registration_404s = 2
        started = time.monotonic()
        self.assertNotIn("error", self.call())
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(self.list_attempts, 3)
        self.assertEqual({method for method, _ in self.requests}, {"GET"})
        self.assertEqual({path for _, path in self.requests}, {"/internal/runs/" + RUN + "/assets"})
        self.registration_404s = 10000
        started = time.monotonic()
        self.assertIn("error", self.call())
        elapsed = time.monotonic() - started
        self.assertGreater(elapsed, 4.5)
        self.assertLessEqual(elapsed, 5.0)
        self.assertEqual({method for method, _ in self.requests}, {"GET"})

    def test_other_errors_and_redirects_do_not_retry(self):
        for status in (401, 403, 500, 302):
            with self.subTest(status=status):
                self.list_status = status
                before = len(self.requests)
                self.assertIn("error", self.call())
                self.assertEqual(len(self.requests), before + 1)

    def test_bad_hash_headers_or_truncated_download_never_delivers_partial(self):
        for problem in ("corrupt", "truncate", "header_hash"):
            with self.subTest(problem=problem):
                setattr(self, problem, "0" * 64 if problem == "header_hash" else True)
                self.assertIn("error", self.call())
                self.assertEqual(list((self.root / RUN).rglob("*")), [])
                setattr(self, problem, None if problem == "header_hash" else False)

    def test_invalid_input_metadata_and_quotas_rejected_before_download(self):
        good = self.assets[0]
        bad_lists = [
            [{**good, "name": "../escape.zip"}], [{**good, "name": "folder/file.zip"}],
            [{**good, "asset_id": "../../outside"}], [{**good, "mime": "Application/Zip"}],
            [{**good, "size": True}], [{**good, "size": 10 * 1024 * 1024 + 1}],
            [{**good, "sha256": "wrong"}], [good] * 9, [good, good],
            [{**good, "asset_id": str(uuid.uuid4()), "size": 10 * 1024 * 1024} for _ in range(3)],
        ]
        for assets in bad_lists:
            with self.subTest(assets=assets):
                self.assets = assets
                before = len(self.requests)
                self.assertIn("error", self.call())
                self.assertEqual(len(self.requests), before + 1)
                self.assertEqual(list((self.root / RUN).rglob("*")), [])


if __name__ == "__main__":
    unittest.main()
