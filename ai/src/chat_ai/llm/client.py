"""Common LLM call module (6-2): route name -> adapter call with the route's settings and timeout."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing

from chat_ai.llm.types import (
    INTERNAL_ERROR,
    PROVIDER_TIMEOUT,
    Adapter,
    Done,
    LlmError,
    LlmRequest,
    LlmResult,
    StreamEvent,
    TextChunk,
)
from chat_ai.observe.tracer import Trace
from chat_ai.prompt.assembler import AssembledPrompt
from chat_ai.settings import Route


async def iterate_within[T](source: AsyncIterator[T], seconds: float) -> AsyncGenerator[T]:
    """Yields items from `source` and raises TimeoutError once `seconds` have passed in total.

    The deadline wraps only the wait for the next item, never the `yield` itself: a timeout that
    fired while the consumer was busy would otherwise cancel the consumer's task instead of
    surfacing here as TimeoutError.
    """
    deadline = asyncio.get_running_loop().time() + seconds
    iterator = source.__aiter__()
    try:
        while True:
            try:
                async with asyncio.timeout_at(deadline):
                    item = await anext(iterator)
            except StopAsyncIteration:
                return
            yield item
    finally:
        aclose = getattr(iterator, "aclose", None)
        if aclose is not None:
            await aclose()


class LlmClient:
    def __init__(self, routes: dict[str, Route], adapters: dict[str, Adapter]) -> None:
        self._routes = routes
        self._adapters = adapters
        for route in routes.values():
            if route.provider not in adapters:
                raise ValueError(f"route {route.name} names provider {route.provider} with no adapter")

    def resolve(self, route_name: str) -> tuple[Route, Adapter]:
        route = self._routes[route_name]
        return route, self._adapters[route.provider]

    @staticmethod
    def _request(route: Route, prompt: AssembledPrompt) -> LlmRequest:
        return LlmRequest(
            model=route.model,
            max_output_tokens=route.max_output_tokens,
            timeout_seconds=route.timeout_seconds,
            params=route.params,
            prompt=prompt,
        )

    @staticmethod
    def _parameters(route: Route) -> dict[str, object]:
        return {"max_output_tokens": route.max_output_tokens, "timeout_seconds": route.timeout_seconds, **route.params}

    async def stream(self, route_name: str, prompt: AssembledPrompt, trace: Trace) -> AsyncGenerator[StreamEvent]:
        """Yields TextChunk… then Done. Raises LlmError. The route timeout covers the whole call."""
        route, adapter = self.resolve(route_name)
        request = self._request(route, prompt)
        trace.generation_started(
            model=route.model, provider=adapter.name, parameters=self._parameters(route), prompt=prompt
        )
        collected: list[str] = []
        first = True
        finished = False
        try:
            # aclosing: when our consumer stops early, the provider stream is closed right away.
            async with aclosing(iterate_within(adapter.stream(request), route.timeout_seconds)) as events:
                async for event in events:
                    if isinstance(event, TextChunk):
                        if first:
                            trace.first_token()
                            first = False
                        collected.append(event.text)
                    elif isinstance(event, Done):
                        trace.generation_finished(
                            output=event.result.text,
                            usage=event.result.usage,
                            error=None,
                            stop_reason=event.result.finish_reason,
                        )
                        finished = True
                    yield event
        except TimeoutError as exc:
            error = LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=str(exc))
            trace.generation_finished(output="".join(collected), usage=None, error=error)
            finished = True
            raise error from exc
        except LlmError as error:
            trace.generation_finished(output="".join(collected), usage=None, error=error, stop_reason=error.stop_reason)
            finished = True
            raise
        except (asyncio.CancelledError, GeneratorExit):
            # Cancelled from outside (backend disconnect, request time limit, consumer closed us).
            # Not a provider failure: the trace records it with its own outcome in finish().
            if not finished:  # closed after Done: the record is already complete
                trace.generation_interrupted(output="".join(collected))
            finished = True
            raise
        finally:
            # Any other way out (an unexpected exception) still closes the generation record so
            # the trace never shows a dangling llm_call.
            if not finished:
                ended = LlmError(INTERNAL_ERROR, "generation ended without a result")
                trace.generation_finished(output="".join(collected), usage=None, error=ended)

    async def complete(self, route_name: str, prompt: AssembledPrompt, trace: Trace) -> LlmResult:
        route, adapter = self.resolve(route_name)
        request = self._request(route, prompt)
        trace.generation_started(
            model=route.model, provider=adapter.name, parameters=self._parameters(route), prompt=prompt
        )
        result: LlmResult | None = None
        try:
            async with asyncio.timeout(route.timeout_seconds):
                result = await adapter.complete(request)
        except TimeoutError as exc:
            error = LlmError(PROVIDER_TIMEOUT, "provider call exceeded its time limit", provider_detail=str(exc))
            trace.generation_finished(output=None, usage=None, error=error)
            raise error from exc
        except LlmError as error:
            trace.generation_finished(output=None, usage=None, error=error, stop_reason=error.stop_reason)
            raise
        except asyncio.CancelledError:
            trace.generation_interrupted(output=None)
            raise
        except BaseException:
            ended = LlmError(INTERNAL_ERROR, "generation ended without a result")
            trace.generation_finished(output=None, usage=None, error=ended)
            raise
        trace.generation_finished(output=result.text, usage=result.usage, error=None, stop_reason=result.finish_reason)
        return result

    async def close(self) -> None:
        for adapter in self._adapters.values():
            await adapter.close()
