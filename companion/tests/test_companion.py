"""Small shared job helpers; public HTTP round trips live in TS integration tests.

Python safety scenarios live in test_gateway, test_assets and test_file_plugin.
"""

from __future__ import annotations

import base64
import time
from uuid import uuid4

from hermes_bridge import JobService


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
