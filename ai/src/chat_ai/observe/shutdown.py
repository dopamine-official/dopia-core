"""Bounded shutdown of the observation clients (7-3-6 서버 종료).

The PostHog SDK drains its queues with no time limit, so a PostHog outage during a deploy would
hold the process until the platform kills it. Each client shuts down on a daemon thread; whatever
is still queued when the limit passes is dropped (the SDK's worker threads are daemons too).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Callable

log = logging.getLogger("chat_ai.observe")


async def shutdown_within(closers: list[Callable[[], None]], seconds: float) -> bool:
    """Runs every closer at once and waits up to `seconds` in total. Returns False on timeout."""
    threads = [threading.Thread(target=fn, name="observe-shutdown", daemon=True) for fn in closers]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + seconds
    while any(t.is_alive() for t in threads):
        if time.monotonic() >= deadline:
            log.warning("observation shutdown exceeded %.0fs; dropping unsent records", seconds)
            return False
        await asyncio.sleep(0.05)
    return True
