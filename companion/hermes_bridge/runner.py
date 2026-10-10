"""The sole integration boundary with an externally installed Hermes Agent."""

from __future__ import annotations

import os
import re
from typing import Any, Callable
from urllib.parse import urlsplit

from .core import BridgeError, RunInput, RunResult


class HermesRunner:
    """Use Hermes's public API, not CLI model routing or CLI session storage.

    Set HERMES_HOME in the process environment before launch: importing run_agent
    loads that home's .env. Profiles must not be switched in a running companion.
    Conversation history is supplied exclusively by the companion's SQLite store;
    session_id is an identifier, not a request to load Hermes CLI session history.
    """

    def __init__(self, model: str | None = None, *, agent_factory: Callable[..., Any] | None = None):
        selected_model = model if model is not None else os.environ.get("HERMES_MODEL", "")
        if not selected_model.strip():
            raise ValueError("An explicit model is required via --model or HERMES_MODEL.")
        self.model = selected_model.strip()
        self._agent_factory = agent_factory
        self._route: dict[str, str] = {}
        self._api_key: str | None = None
        route_names = ("HERMES_BRIDGE_PROVIDER", "HERMES_BRIDGE_BASE_URL", "HERMES_BRIDGE_API_MODE")
        if any(name in os.environ for name in (*route_names, "HERMES_BRIDGE_API_KEY_ENV")):
            values = [os.environ.get(name, "") for name in route_names]
            if any(not value.strip() for value in values):
                raise ValueError("Explicit routing requires HERMES_BRIDGE_PROVIDER, HERMES_BRIDGE_BASE_URL, and HERMES_BRIDGE_API_MODE.")
            if any(ord(c) < 32 or 127 <= ord(c) <= 159 for value in values for c in value):
                raise ValueError("Explicit route fields must not contain control characters.")
            provider, base_url, api_mode = (value.strip() for value in values)
            try:
                parsed = urlsplit(base_url)
                valid_url = (parsed.scheme in ("http", "https") and bool(parsed.hostname)
                             and parsed.username is None and parsed.password is None
                             and "?" not in base_url and "#" not in base_url
                             and not any(c.isspace() for c in base_url))
                # Accessing port also rejects malformed/out-of-range ports.
                parsed.port
            except ValueError:
                valid_url = False
            if not valid_url:
                raise ValueError("HERMES_BRIDGE_BASE_URL must be an HTTP(S) URL with a hostname and no userinfo, query, or fragment.")
            if api_mode != "chat_completions":
                raise ValueError("HERMES_BRIDGE_API_MODE must be chat_completions.")
            key_env = os.environ.get("HERMES_BRIDGE_API_KEY_ENV", "HERMES_BRIDGE_MODEL_API_KEY")
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env) is None:
                raise ValueError("HERMES_BRIDGE_API_KEY_ENV must be a valid environment variable name.")
            api_key = os.environ.get(key_env, "")
            if not api_key.strip():
                raise ValueError("The environment variable selected by HERMES_BRIDGE_API_KEY_ENV must be nonempty.")
            self._route = {"provider": provider, "base_url": base_url, "api_mode": api_mode}
            # Capture before importing Hermes (which may load its own .env).
            self._api_key = api_key

    def run(self, request: RunInput) -> RunResult:
        factory = self._agent_factory
        if factory is None:
            from run_agent import AIAgent
            factory = AIAgent
        options: dict[str, Any] = {"session_id": request.thread_id, "model": self.model, "quiet_mode": True}
        if self._route:
            options.update(self._route)
            options["api_key"] = self._api_key
        agent = factory(**options)
        result = agent.run_conversation(
            user_message=request.user_message,
            # Hermes appends this context to its normal system prompt.
            system_message=request.system_message,
            conversation_history=request.conversation_history,
            task_id=request.job_id,
        )
        if not isinstance(result, dict):
            raise BridgeError("invalid_result", "Hermes returned an invalid result.")
        # Providers/tools can report failure without throwing. Never promote their
        # partial response or error (which may contain credentials) to job output.
        if (result.get("completed") is False
                or any(result.get(flag) is True for flag in ("failed", "partial", "interrupted"))
                or result.get("error")):
            raise BridgeError("hermes_incomplete", "Hermes did not complete the job.")
        if not isinstance(result.get("final_response"), str) or not isinstance(result.get("messages"), list):
            raise BridgeError("invalid_result", "Hermes returned an invalid result.")
        # Older versions omit completed; valid legacy results remain supported.
        return RunResult(final_response=result["final_response"], messages=result["messages"])
