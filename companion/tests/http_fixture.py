"""Authenticated TEST-ONLY echo fixture for HTTP ↔ TypeScript integration.

Run: PYTHONPATH=companion python companion/tests/http_fixture.py --workspace DIR --port 0
Requires HERMES_BRIDGE_TOKEN. Prints one JSON readiness line containing host and port.
POST/GET use the production server/service. Supported input images are echoed
inline byte-for-byte, with their original filenames; response text echoes input.
The reserved text __fixture_fail__ raises a sanitized runner failure for integration.
This module is deliberately excluded from the installed production package.
Opt-in --native-files uses the production GatewayRunner and actual file plugin;
only its upstream Gateway/runtime/model are fake, all asset HTTP remains real.
"""

from __future__ import annotations

import argparse
from contextlib import ExitStack
from contextvars import ContextVar
import importlib
import json
import io
import os
from pathlib import Path
import sys
import threading
import types
from unittest.mock import patch
from uuid import uuid4
import zipfile

from hermes_bridge import GatewayRunner, JobService, RunInput, RunResult
from hermes_bridge.core import wire_json
from hermes_bridge.server import BridgeHandler, BridgeHTTPServer


class EchoRunner:
    scope = "test-only-inline-adapter-v1"

    def run(self, request: RunInput) -> RunResult:
        if request.text == "__fixture_fail__":
            raise RuntimeError("test-provider-secret-must-not-escape")
        if request.input_assets is not None:
            # TEST ONLY: emulate native admission without contacting any Gateway.
            # Exercise the same sealed store and completion-freeze path as production.
            checkpoint = request.checkpoint
            record, fresh = checkpoint.prepare(wire_json({"fixture": request.text}), self.scope,
                                               "opencode-" + request.thread_id)
            run_id = record.run_id
            if fresh:
                run_id = "run_" + uuid4().hex
                checkpoint.accepted(run_id)
            store = checkpoint.service.assets
            for item in store.list_inputs(run_id)["input_assets"]:
                _, data = store.get(None, item["asset_id"], run_id=run_id)
                store.put_output(run_id, {**item, "asset_id": str(uuid4())}, io.BytesIO(data))
        return RunResult(request.text, attachments=list(request.attachments))


class NativeFilesFixture:
    """One owned fake native runtime; never writes AssetStore or job checkpoints."""

    def __init__(self, root: Path, stack: ExitStack):
        from test_gateway import FakeGateway, SUCCESS_FLAGS

        self.root = root
        self.stats_path = root / "native-stats.json"
        self.plugin_root = root / "native-plugin-workspaces"
        self.plugin_root.mkdir(mode=0o700)
        uploads = root / "uploads"
        uploads.mkdir(mode=0o700)
        with zipfile.ZipFile(uploads / "native-original.zip", "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("payload.bin", b"\x00\xff\xfeoriginal opaque ZIP payload\x00")
            archive.writestr("../must-not-extract.txt", b"The file tools must not extract this archive.")

        # Import only this repo's independently installable plugin, not a profile.
        plugin_parent = str(Path(__file__).resolve().parents[2] / "integrations")
        sys.path.insert(0, plugin_parent)
        try:
            self.plugin = importlib.import_module("hermes_file_plugin")
        finally:
            sys.path.remove(plugin_parent)
        self.run_id = "run_" + uuid4().hex
        self.gateway_token = "fixture-native-" + uuid4().hex
        self.context = ContextVar("_approval_session_key", default="")
        approval = types.ModuleType("tools.approval_context")
        approval._approval_session_key = self.context
        stack.enter_context(patch.dict(sys.modules, {
            "tools": types.ModuleType("tools"), "tools.approval_context": approval,
        }))
        self.lock = threading.Lock()
        self.plugin_lock = threading.Lock()
        self.http_calls = []
        self.plugin_calls = []
        self.plugin_evidence = {}
        self.terminal_reply = None
        self.gateway = stack.enter_context(FakeGateway())

        def accept(handler):
            if handler.headers.get("Authorization") != "Bearer " + self.gateway_token:
                return 401, {"error": "fixture native authentication failed"}
            self.write_stats()
            return 202, {"run_id": self.run_id, "status": "started", "replayed": False}

        def complete(handler):
            if (handler.headers.get("Authorization") != "Bearer " + self.gateway_token
                    or handler.path != "/v1/runs/" + self.run_id):
                return 403, {"error": "fixture native scope denied"}
            # This callback runs only on GET, after the genuine 202 exchange and
            # GatewayRunner.accepted checkpoint. No manual job/run binding exists.
            with self.plugin_lock:
                if self.terminal_reply is None:
                    context_token = self.context.set(self.run_id)
                    try:
                        imported = self.call_plugin("bridge_files", {})
                        workspace = Path(imported["workspace"])
                        if workspace != self.plugin_root / self.run_id or len(imported["input_assets"]) != 1:
                            raise ValueError("Unexpected fixture workspace or input count.")
                        source = imported["input_assets"][0]
                        local_output = workspace / "native-returned.zip"
                        # Stand-in for the original model's ordinary local file tool.
                        # Neither zip extraction nor a second agent is involved.
                        local_output.write_bytes(Path(source["path"]).read_bytes())
                        published = self.call_plugin("bridge_publish_file", {
                            "path": local_output.name, "mime": "application/zip",
                        })
                        self.plugin_evidence = {"workspace": str(workspace), "input": source, "published": published}
                        self.terminal_reply = (200, {"run_id": self.run_id, "status": "completed",
                                                    "output": "Original ZIP published through the file plugin.", **SUCCESS_FLAGS})
                    except Exception:
                        # Preserve the actual safe plugin error, never silently turn
                        # a protocol mismatch into synthetic successful output.
                        self.plugin_evidence.setdefault("error", "Native fixture plugin execution failed.")
                        self.terminal_reply = (200, {"run_id": self.run_id, "status": "failed", "output": "",
                                                    "completed": False, "partial": False, "interrupted": False})
                    finally:
                        self.context.reset(context_token)
                self.write_stats()
                return self.terminal_reply

        self.gateway.post_reply = accept
        self.gateway.get_reply = complete
        self.runner = GatewayRunner(self.gateway.url, self.gateway_token, timeout=5, poll_interval=0.01)
        self.write_stats()

    def call_plugin(self, name, args):
        self.plugin_calls.append(name)
        value = getattr(self.plugin, name)(args)
        if not isinstance(value, str):
            raise TypeError("File plugin handler did not return JSON text.")
        result = json.loads(value)
        if "error" in result:
            self.plugin_evidence["error"] = result["error"]
            raise ValueError("File plugin refused fixture operation.")
        return result

    def configure(self, server: BridgeHTTPServer, file_token: str, stack: ExitStack):
        stack.enter_context(patch.dict(os.environ, {
            "HERMES_BRIDGE_FILES_LOCAL": "1", "HERMES_BRIDGE_FILE_ROOT": str(self.plugin_root),
            "HERMES_BRIDGE_FILE_TOKEN": file_token,
            "HERMES_BRIDGE_FILES_URL": f"http://127.0.0.1:{server.server_port}",
        }, clear=True))
        fixture = self

        class ObservedHandler(BridgeHandler):
            # Observation only: all auth, routing, bodies, headers and asset I/O
            # use the unmodified production handler. There is no debug HTTP route.
            def log_request(self, code="-", size="-"):
                fixture.write_stats({"method": self.command, "path": self.path, "status": code})

        server.RequestHandlerClass = ObservedHandler

    def write_stats(self, call=None):
        with self.lock:
            if call is not None:
                self.http_calls.append(call)
            posts = self.gateway.posts()
            value = {
                "runner": type(self.runner).__name__ if hasattr(self, "runner") else "GatewayRunner",
                "plugin_module": str(Path(self.plugin.__file__).resolve()),
                "run_id": self.run_id, "native_posts": len(posts),
                "native_gets": sum(call[0] == "GET" for call in self.gateway.calls),
                "native_requests": [json.loads(call[3]) for call in posts],
                "native_job_ids": [call[2].get("Idempotency-Key") for call in posts],
                "plugin_calls": self.plugin_calls, "plugin": self.plugin_evidence,
                "http": self.http_calls,
            }
            temp = self.stats_path.with_suffix(".tmp")
            temp.write_bytes(wire_json(value))
            temp.replace(self.stats_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--native-files", action="store_true", help="TEST ONLY: real GatewayRunner + file plugin, fake native runtime")
    args = parser.parse_args()
    token = os.environ.get("HERMES_BRIDGE_TOKEN", "")
    if not token.strip():
        parser.error("HERMES_BRIDGE_TOKEN is required even for test fixtures.")
    file_token = os.environ.get("HERMES_BRIDGE_FILE_TOKEN", "")
    if args.native_files and not file_token:
        parser.error("--native-files requires an independent fixture file token.")
    os.umask(0o077)
    args.workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chdir(args.workspace.resolve())
    with ExitStack() as stack:
        native = NativeFilesFixture(Path.cwd().parent, stack) if args.native_files else None
        service = JobService(Path.cwd(), native.runner if native else EchoRunner(), autostart=False,
                             files_enabled=bool(file_token))
        stack.callback(service.close)
        server = BridgeHTTPServer(("127.0.0.1", args.port), service, token, file_token=file_token)
        stack.callback(server.server_close)
        if native:
            native.configure(server, file_token, stack)
        service.start()
        print(json.dumps({"host": server.server_address[0], "port": server.server_address[1]}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
