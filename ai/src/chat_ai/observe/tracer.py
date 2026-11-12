"""Trace recording (7-3). One Trace per request: a prompt_assembly span and an llm_call generation.

They go to PostHog LLM analytics as `$ai_trace`, `$ai_span`, and `$ai_generation` events with the
requesting account as `distinct_id`, so they sit on the same person page as the web events.

Sending never blocks a response: PostHog batches in a background thread, and every
recording call swallows its own errors into a single log line.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from chat_ai.llm.types import LlmError, LlmUsage
from chat_ai.prompt.assembler import AssembledPrompt

log = logging.getLogger("chat_ai.observe")

Outcome = str  # completed | failed | cancelled


class Trace(Protocol):
    def prompt_assembled(self, prompt: AssembledPrompt, *, history_count: int, summary_length: int) -> None: ...

    def generation_started(
        self, *, model: str, provider: str, parameters: dict[str, Any], prompt: AssembledPrompt
    ) -> None: ...

    def first_token(self) -> None: ...

    def generation_finished(
        self, *, output: str | None, usage: LlmUsage | None, error: LlmError | None, stop_reason: str | None = None
    ) -> None: ...

    def generation_interrupted(self, *, output: str | None) -> None:
        """The call was cancelled from outside. finish() settles the record with the trace outcome."""
        ...

    def finish(self, *, outcome: Outcome, output: Any, error_code: str | None) -> None: ...


class Tracer(Protocol):
    def start(self, *, name: str, request_id: str, distinct_id: str, input: Any, metadata: dict[str, Any]) -> Trace: ...

    def shutdown(self) -> None: ...


class NoopTrace:
    def prompt_assembled(self, prompt: AssembledPrompt, *, history_count: int, summary_length: int) -> None:
        return None

    def generation_started(
        self, *, model: str, provider: str, parameters: dict[str, Any], prompt: AssembledPrompt
    ) -> None:
        return None

    def first_token(self) -> None:
        return None

    def generation_finished(
        self, *, output: str | None, usage: LlmUsage | None, error: LlmError | None, stop_reason: str | None = None
    ) -> None:
        return None

    def generation_interrupted(self, *, output: str | None) -> None:
        return None

    def finish(self, *, outcome: Outcome, output: Any, error_code: str | None) -> None:
        return None


class NoopTracer:
    def start(self, *, name: str, request_id: str, distinct_id: str, input: Any, metadata: dict[str, Any]) -> Trace:
        return NoopTrace()

    def shutdown(self) -> None:
        return None


@dataclass
class TraceRecord:
    """What a trace captured. Used by the in-memory tracer (tests, eval CLI)."""

    name: str
    request_id: str
    distinct_id: str
    input: Any
    metadata: dict[str, Any]
    prompt_version: str | None = None
    model: str | None = None
    provider: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    prompt: dict[str, Any] | None = None
    first_token_at: datetime | None = None
    generation_output: str | None = None
    usage: LlmUsage | None = None
    stop_reason: str | None = None
    generation_interrupted: bool = False
    generation_error: str | None = None
    outcome: Outcome | None = None
    output: Any = None
    error_code: str | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None

    @property
    def duration_ms(self) -> int | None:
        if self.finished_at is None:
            return None
        return int((self.finished_at - self.started_at).total_seconds() * 1000)


class MemoryTrace:
    def __init__(self, record: TraceRecord) -> None:
        self.record = record

    def prompt_assembled(self, prompt: AssembledPrompt, *, history_count: int, summary_length: int) -> None:
        self.record.prompt_version = prompt.prompt_version
        self.record.metadata["history_count"] = history_count
        self.record.metadata["summary_length"] = summary_length

    def generation_started(
        self, *, model: str, provider: str, parameters: dict[str, Any], prompt: AssembledPrompt
    ) -> None:
        self.record.model = model
        self.record.provider = provider
        self.record.parameters = parameters
        self.record.prompt = prompt.as_dict()

    def first_token(self) -> None:
        self.record.first_token_at = datetime.now(UTC)

    def generation_finished(
        self, *, output: str | None, usage: LlmUsage | None, error: LlmError | None, stop_reason: str | None = None
    ) -> None:
        self.record.generation_output = output
        self.record.stop_reason = stop_reason
        self.record.usage = usage
        self.record.generation_error = error.provider_detail or error.code if error else None

    def generation_interrupted(self, *, output: str | None) -> None:
        self.record.generation_output = output
        self.record.generation_interrupted = True

    def finish(self, *, outcome: Outcome, output: Any, error_code: str | None) -> None:
        if self.record.generation_interrupted and outcome == "failed":
            self.record.generation_error = error_code
        self.record.outcome = outcome
        self.record.output = output
        self.record.error_code = error_code
        self.record.finished_at = datetime.now(UTC)


class MemoryTracer:
    def __init__(self) -> None:
        self.records: list[TraceRecord] = []

    def start(self, *, name: str, request_id: str, distinct_id: str, input: Any, metadata: dict[str, Any]) -> Trace:
        record = TraceRecord(
            name=name, request_id=request_id, distinct_id=distinct_id, input=input, metadata=dict(metadata)
        )
        self.records.append(record)
        return MemoryTrace(record)

    def shutdown(self) -> None:
        return None


def _seconds(start: float, end: float | None = None) -> float:
    return round((end if end is not None else time.monotonic()) - start, 3)


def _messages(prompt: AssembledPrompt) -> list[dict[str, str]]:
    """The prompt as one message list, system first, exactly as sent to the provider."""
    return [{"role": "system", "content": prompt.system}, *prompt.as_dict()["messages"]]


class PostHogTrace:
    def __init__(
        self, client: Any, *, name: str, request_id: str, distinct_id: str, input: Any, base: dict[str, Any]
    ) -> None:
        self._client = client
        self._name = name
        self._trace_id = request_id
        self._distinct_id = distinct_id
        self._input = input
        self._base = base  # metadata + app_release, added to every event
        self._started = time.monotonic()
        self._generation: dict[str, Any] | None = None

    def _capture(self, event: str, properties: dict[str, Any]) -> None:
        try:
            # The AI lane: its own endpoint and a per-event size cap far above the analytics lane's,
            # since every record carries the full prompt.
            self._client.capture_ai(
                event,
                distinct_id=self._distinct_id,
                properties={**self._base, "$ai_trace_id": self._trace_id, **properties},
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("request_id=%s posthog %s capture failed: %s", self._trace_id, event, exc)

    def prompt_assembled(self, prompt: AssembledPrompt, *, history_count: int, summary_length: int) -> None:
        self._base["prompt_version"] = prompt.prompt_version
        self._capture(
            "$ai_span",
            {
                "$ai_span_id": str(uuid.uuid4()),
                "$ai_parent_id": self._trace_id,
                "$ai_span_name": "prompt_assembly",
                "$ai_input_state": {"history_count": history_count, "summary_length": summary_length},
                "$ai_output_state": prompt.as_dict(),
                "$ai_latency": _seconds(self._started),
            },
        )

    def generation_started(
        self, *, model: str, provider: str, parameters: dict[str, Any], prompt: AssembledPrompt
    ) -> None:
        self._generation = {
            "started": time.monotonic(),
            "first_token": None,
            "properties": {
                "$ai_span_id": str(uuid.uuid4()),
                "$ai_parent_id": self._trace_id,
                "$ai_span_name": "llm_call",
                "$ai_model": model,
                "$ai_provider": provider,
                "model_parameters": dict(parameters),
                "$ai_input": _messages(prompt),
            },
        }

    def first_token(self) -> None:
        if self._generation is not None and self._generation["first_token"] is None:
            self._generation["first_token"] = time.monotonic()

    def generation_finished(
        self, *, output: str | None, usage: LlmUsage | None, error: LlmError | None, stop_reason: str | None = None
    ) -> None:
        error_text = f"{error.code}: {error.provider_detail or error.message}" if error is not None else None
        self._send_generation(output=output, usage=usage, error=error_text, stop_reason=stop_reason)

    def generation_interrupted(self, *, output: str | None) -> None:
        if self._generation is not None:
            self._generation["interrupted"] = output
            self._generation["ended"] = time.monotonic()

    def _send_generation(
        self,
        *,
        output: str | None,
        usage: LlmUsage | None,
        error: str | None,
        stop_reason: str | None,
        outcome: Outcome | None = None,
    ) -> None:
        generation = self._generation
        if generation is None:
            return
        self._generation = None
        started = generation["started"]
        properties: dict[str, Any] = {
            **generation["properties"],
            "$ai_output_choices": [{"role": "assistant", "content": output or ""}],
            "$ai_latency": _seconds(started, generation.get("ended")),
            "$ai_is_error": error is not None,
            "$ai_stop_reason": stop_reason,
        }
        if outcome is not None:
            properties["outcome"] = outcome
        if generation["first_token"] is not None:
            properties["$ai_time_to_first_token"] = _seconds(started, generation["first_token"])
        if usage is not None and usage.input_tokens is not None:
            properties["$ai_input_tokens"] = usage.input_tokens
        if usage is not None and usage.output_tokens is not None:
            properties["$ai_output_tokens"] = usage.output_tokens
        if usage is not None and usage.cache_read_tokens is not None:
            properties["$ai_cache_read_input_tokens"] = usage.cache_read_tokens
        if error is not None:
            properties["$ai_error"] = error
        self._capture("$ai_generation", properties)

    def finish(self, *, outcome: Outcome, output: Any, error_code: str | None) -> None:
        if self._generation is not None and "interrupted" in self._generation:
            # Cancelled from outside: a backend disconnect is not an error; a request time limit is,
            # and carries the trace's code (timeout) rather than a provider error.
            self._send_generation(
                output=self._generation["interrupted"],
                usage=None,
                error=error_code if outcome == "failed" else None,
                stop_reason=None,
                outcome=outcome,
            )
        self._capture(
            "$ai_trace",
            {
                "$ai_span_name": self._name,
                "$ai_input_state": self._input,
                "$ai_output_state": output,
                "$ai_latency": _seconds(self._started),
                "$ai_is_error": outcome == "failed",
                "$ai_error": error_code,
                "outcome": outcome,
            },
        )


class PostHogTracer:
    """PostHog LLM analytics. The trace id is the request id so backend logs and DB rows can find it.

    Records on the shared client (observe/posthog.py), which the app closes.
    """

    def __init__(self, client: Any, *, release: str) -> None:
        self._client = client
        self._props = {"app_release": release}

    def start(self, *, name: str, request_id: str, distinct_id: str, input: Any, metadata: dict[str, Any]) -> Trace:
        base = {**self._props, **{k: v for k, v in metadata.items() if v is not None}}
        return PostHogTrace(
            self._client, name=name, request_id=request_id, distinct_id=distinct_id, input=input, base=base
        )

    def shutdown(self) -> None:
        return None
