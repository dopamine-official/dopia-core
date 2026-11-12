"""Internal shapes crossing the adapter boundary. Provider SDK types never leave an adapter."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from chat_ai.prompt.assembler import AssembledPrompt

# Failure codes (7-1-5). Adapters raise LlmError with one of the provider_* codes.
PROVIDER_TIMEOUT = "provider_timeout"
PROVIDER_RATE_LIMITED = "provider_rate_limited"
PROVIDER_REJECTED = "provider_rejected"
PROVIDER_ERROR = "provider_error"
EMPTY_RESPONSE = "empty_response"
TIMEOUT = "timeout"
INTERNAL_ERROR = "internal_error"
INPUT_INVALID = "input_invalid"


class LlmError(Exception):
    """An execution failure with a contract code. `message` is operator-facing and never
    contains the provider's raw error text (that goes to the trace only)."""

    def __init__(
        self, code: str, message: str, *, provider_detail: str | None = None, stop_reason: str | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.provider_detail = provider_detail
        self.stop_reason = stop_reason  # the provider's stop reason when it ended the call (e.g. refusal)


@dataclass(frozen=True)
class LlmRequest:
    model: str
    max_output_tokens: int
    timeout_seconds: float
    params: dict[str, Any]
    prompt: AssembledPrompt


@dataclass(frozen=True)
class LlmUsage:
    input_tokens: int | None
    output_tokens: int | None
    # Input tokens the provider read from its prompt cache; None when it does not say.
    cache_read_tokens: int | None = None


@dataclass(frozen=True)
class LlmResult:
    text: str
    model: str
    provider: str
    usage: LlmUsage
    finish_reason: str | None


@dataclass(frozen=True)
class TextChunk:
    text: str


@dataclass(frozen=True)
class Done:
    result: LlmResult


StreamEvent = TextChunk | Done


class Adapter(Protocol):
    """One per provider. Converts our request to the SDK call and the SDK output back."""

    name: str

    def stream(self, request: LlmRequest) -> AsyncIterator[StreamEvent]:
        """Yields TextChunk items and finally one Done. Raises LlmError on provider failure."""
        ...

    async def complete(self, request: LlmRequest) -> LlmResult: ...

    async def close(self) -> None: ...
