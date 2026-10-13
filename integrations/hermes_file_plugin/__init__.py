"""File tools for the original Hermes v2026.9.24 instance, not another agent.

Only explicitly enabled local installations are supported. The operator supplies
an existing private root, independently scoped file token, and optionally a
loopback origin. Nothing scans, mounts, or cleans profiles or /opt/data. Run
workspaces persist: the operator must choose retention/cleanup before use and
must not remove a workspace while its run is active. Remote sandbox paths are
not assumed to be visible here. No identity, model, or memory settings change.

Required environment: HERMES_BRIDGE_FILES_LOCAL=1, HERMES_BRIDGE_FILE_ROOT
(absolute, existing, owner 0700), HERMES_BRIDGE_FILE_TOKEN (file-only bearer).
HERMES_BRIDGE_FILES_URL defaults to http://127.0.0.1:8787; only loopback origins,
without credentials, paths, queries, or fragments, are accepted. This directory
is independently installable: it has no companion imports or third-party deps.
"""

import json
import os
import re
from contextvars import ContextVar

from .client import BridgeError, FileClient


def _current_run():
    # Version-pinned private API: deliberately no task/session/environment fallback.
    try:
        from tools.approval_context import _approval_session_key
    except (ImportError, AttributeError):
        raise BridgeError("Trusted Hermes run context is unavailable.") from None
    if not isinstance(_approval_session_key, ContextVar):
        raise BridgeError("Trusted Hermes run context is unavailable.")
    try:
        value = _approval_session_key.get()
    except LookupError:
        raise BridgeError("Trusted Hermes run context is unavailable.") from None
    if not isinstance(value, str) or not re.fullmatch(r"run_[0-9a-f]{32}", value):
        raise BridgeError("Trusted Hermes run context is unavailable.")
    return value


def _invoke(args, publish=False):
    try:
        if not isinstance(args, dict):
            raise BridgeError("Invalid file tool arguments.")
        allowed = {"path", "name", "mime"} if publish else set()
        if set(args) - allowed or (publish and "path" not in args):
            raise BridgeError("Invalid file tool arguments.")
        run = _current_run()
        client = FileClient.from_env()
        result = client.publish(run, **args) if publish else client.files(run)
    except BridgeError as exc:
        result = {"error": str(exc)}
    except (OSError, ValueError, TypeError):
        # Never include OS paths, response bodies, token values, or raw exceptions.
        result = {"error": "Local file operation failed safely."}
    return json.dumps(result, ensure_ascii=True, separators=(",", ":"))


def bridge_files(args, *, task_id=None, session_id=None):
    """The registry's task/session kwargs are not a source of run authority."""
    return _invoke(args)


def bridge_publish_file(args, *, task_id=None, session_id=None):
    return _invoke(args, publish=True)


def _configured():
    """Registry availability check: no filesystem access or network side effects."""
    return (os.environ.get("HERMES_BRIDGE_FILES_LOCAL") == "1"
            and bool(os.environ.get("HERMES_BRIDGE_FILE_ROOT"))
            and bool(os.environ.get("HERMES_BRIDGE_FILE_TOKEN")))


def register(ctx):
    """Official v2026.9.24 registry contract; handlers always return JSON text."""
    tools = (
        (
            "bridge_files",
            "Get this run's input files and private local workspace. ZIPs stay raw; "
            "use ordinary local tools on returned paths. An empty run still has a workspace.",
            {"type": "object", "properties": {}, "additionalProperties": False},
            bridge_files,
        ),
        (
            "bridge_publish_file",
            "Publish a stable snapshot of a regular file inside this run's workspace "
            "(maximum 10 MiB). Returns metadata, never file bytes. ZIPs stay raw.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative or absolute path inside this run's workspace."},
                    "name": {"type": "string", "description": "Optional safe filename, with no directory components."},
                    "mime": {"type": "string", "description": "Optional bare lowercase MIME type; default application/octet-stream."},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            bridge_publish_file,
        ),
    )
    for name, description, parameters, handler in tools:
        ctx.register_tool(
            name=name,
            toolset="bridge_files",
            schema={"name": name, "description": description, "parameters": parameters},
            handler=handler,
            check_fn=_configured,
            requires_env=["HERMES_BRIDGE_FILES_LOCAL", "HERMES_BRIDGE_FILE_ROOT", "HERMES_BRIDGE_FILE_TOKEN"],
            is_async=False,
            description=description,
        )
