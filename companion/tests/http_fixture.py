"""Authenticated TEST-ONLY echo fixture for HTTP ↔ TypeScript integration.

Run: PYTHONPATH=companion python companion/tests/http_fixture.py --workspace DIR --port 0
Requires HERMES_BRIDGE_TOKEN. Prints one JSON readiness line containing host and port.
POST/GET use the production server/service. Every upload is copied byte-for-byte to
the current output directory, with its original filename; response text echoes input.
The reserved text __fixture_fail__ raises a sanitized runner failure for integration.
This module is deliberately excluded from the installed production package.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil

from hermes_bridge import JobService, RunInput, RunResult
from hermes_bridge.server import BridgeHTTPServer


class EchoRunner:
    def run(self, request: RunInput) -> RunResult:
        if request.text == "__fixture_fail__":
            raise RuntimeError("test-provider-secret-must-not-escape")
        lines = [request.text]
        for source in request.uploads:
            target = request.output_dir / source.name
            shutil.copyfile(source, target)
            lines.append(f"MEDIA:{target}")
        messages = request.conversation_history + [
            {"role": "user", "content": request.text},
            {"role": "assistant", "content": request.text},
        ]
        return RunResult("\n".join(lines), messages)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    token = os.environ.get("HERMES_BRIDGE_TOKEN", "")
    if not token.strip():
        parser.error("HERMES_BRIDGE_TOKEN is required even for test fixtures.")
    os.umask(0o077)
    args.workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chdir(args.workspace.resolve())
    service = JobService(Path.cwd(), EchoRunner())
    server = BridgeHTTPServer(("127.0.0.1", args.port), service, token)
    print(json.dumps({"host": server.server_address[0], "port": server.server_address[1]}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        service.close()


if __name__ == "__main__":
    main()
