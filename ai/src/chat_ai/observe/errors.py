"""Internal error reporting (7-1-2 내부 오류 → PostHog). Prompt and response text never go here."""

from __future__ import annotations

import logging
from typing import Protocol

log = logging.getLogger("chat_ai.observe")


class ErrorReporter(Protocol):
    def report(self, exc: BaseException, *, request_id: str, subtask: str) -> None: ...

    def shutdown(self) -> None: ...


class NoopErrorReporter:
    def __init__(self) -> None:
        self.reported: list[tuple[BaseException, str, str]] = []

    def report(self, exc: BaseException, *, request_id: str, subtask: str) -> None:
        self.reported.append((exc, request_id, subtask))

    def shutdown(self) -> None:
        return None


class PostHogErrorReporter:
    def __init__(self, *, api_key: str, host: str | None, environment: str, release: str) -> None:
        from posthog import Posthog

        self._client = Posthog(project_api_key=api_key, host=host) if host else Posthog(project_api_key=api_key)
        self._props = {"service": "chat-ai", "environment": environment, "release": release}

    def report(self, exc: BaseException, *, request_id: str, subtask: str) -> None:
        try:
            self._client.capture_exception(
                exc,
                distinct_id=f"chat-ai:{request_id}",
                properties={**self._props, "request_id": request_id, "subtask": subtask},
            )
        except Exception as e:  # noqa: BLE001
            log.warning("posthog capture failed: %s", e)

    def shutdown(self) -> None:
        try:
            self._client.shutdown()
        except Exception as e:  # noqa: BLE001
            log.warning("posthog shutdown failed: %s", e)
