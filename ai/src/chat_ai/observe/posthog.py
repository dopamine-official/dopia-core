"""The one PostHog client of this server, shared by AI call records and error reports."""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("chat_ai.observe")


def connect(*, api_key: str, host: str | None) -> Any:
    from posthog import Posthog

    return Posthog(project_api_key=api_key, host=host) if host else Posthog(project_api_key=api_key)


def close(client: Any) -> None:
    """Sends what is queued and stops the client's threads; bounded by shutdown_within."""
    try:
        client.shutdown()
    except Exception as exc:  # noqa: BLE001
        log.warning("posthog shutdown failed: %s", exc)
