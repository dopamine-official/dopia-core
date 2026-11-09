"""Internal error reporting (7-1-2 내부 오류 → PostHog). Prompt and response text never go here."""

from __future__ import annotations

import logging
from typing import Any, Protocol

log = logging.getLogger("chat_ai.observe")


class ErrorReporter(Protocol):
    def report(self, exc: BaseException, *, request_id: str, account_id: str, subtask: str) -> None: ...

    def shutdown(self) -> None: ...


class NoopErrorReporter:
    def __init__(self) -> None:
        self.reported: list[tuple[BaseException, str, str, str]] = []

    def report(self, exc: BaseException, *, request_id: str, account_id: str, subtask: str) -> None:
        self.reported.append((exc, request_id, account_id, subtask))

    def shutdown(self) -> None:
        return None


class PostHogErrorReporter:
    """Reports on the shared client (observe/posthog.py), which the app closes."""

    def __init__(self, client: Any, *, environment: str, release: str) -> None:
        self._client = client
        self._props = {"service": "chat-ai", "environment": environment, "app_release": release}

    def report(self, exc: BaseException, *, request_id: str, account_id: str, subtask: str) -> None:
        try:
            # Under the requesting account, like the AI call records, so the error sits on that
            # person's timeline; request_id links it to the trace and the backend turn.
            self._client.capture_exception(
                exc,
                distinct_id=account_id,
                properties={**self._props, "request_id": request_id, "subtask": subtask},
            )
        except Exception as e:  # noqa: BLE001
            log.warning("posthog capture failed: %s", e)

    def shutdown(self) -> None:
        return None
