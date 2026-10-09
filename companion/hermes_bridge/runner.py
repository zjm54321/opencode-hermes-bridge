"""The sole integration boundary with an externally installed Hermes Agent."""

from __future__ import annotations

import os
from typing import Any, Callable

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

    def run(self, request: RunInput) -> RunResult:
        factory = self._agent_factory
        if factory is None:
            from run_agent import AIAgent
            factory = AIAgent
        options: dict[str, Any] = {"session_id": request.thread_id, "model": self.model, "quiet_mode": True}
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
