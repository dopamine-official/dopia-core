"""Evaluation CLI (6-5): runs chat turns from a JSONL file through the production pipeline.

Each line is a chat turn request body (5-2). Output is one JSON line per case with the
response, meta, and outcome, so the same prompt and model settings are measured as deployed.

    chat-ai-eval cases.jsonl --out runs/2026-11-06.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from chat_ai.api.router import chat_input
from chat_ai.api.schemas import ChatTurnRequest
from chat_ai.chat.generate import assemble_chat_prompt, generate_turn
from chat_ai.llm.adapters import build_adapters
from chat_ai.llm.client import LlmClient
from chat_ai.observe.errors import NoopErrorReporter
from chat_ai.observe.tracer import MemoryTracer
from chat_ai.prompt.assembler import PromptAssembler
from chat_ai.settings import load_settings


async def run_case(
    case: dict[str, Any], *, assembler: PromptAssembler, llm: LlmClient, timeout: float
) -> dict[str, Any]:
    tracer = MemoryTracer()
    request_id = f"eval-{uuid.uuid4()}"
    turn = chat_input(request_id, "eval", ChatTurnRequest.model_validate(case))
    trace = tracer.start(name="chat_turn", request_id=request_id, distinct_id="eval", input=case, metadata={})
    prompt = assemble_chat_prompt(assembler, turn, trace)
    final: dict[str, Any] = {}
    async for event in generate_turn(
        turn,
        prompt,
        llm=llm,
        trace=trace,
        errors=NoopErrorReporter(),
        request_timeout_seconds=timeout,
        received_at=time.monotonic(),
    ):
        if event.name != "token":
            final = {"event": event.name, **event.data}
    return {"request_id": request_id, "route": turn.route_name, "prompt_version": prompt.prompt_version, **final}


async def run(path: Path, out: Path | None, limit: int | None) -> int:
    settings = load_settings()
    assembler = PromptAssembler(settings.prompt_dir)
    llm = LlmClient(settings.routes, build_adapters(settings))
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if limit is not None:
        cases = cases[:limit]
    sink = out.open("w", encoding="utf-8") if out else sys.stdout
    failures = 0
    try:
        for case in cases:
            result = await run_case(case, assembler=assembler, llm=llm, timeout=settings.chat_request_timeout_seconds)
            failures += result.get("event") != "completed"
            sink.write(json.dumps(result, ensure_ascii=False) + "\n")
            sink.flush()
    finally:
        if out:
            sink.close()
        await llm.close()
    print(f"cases={len(cases)} failed={failures}", file=sys.stderr)
    return 0 if failures == 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Run chat turns through the chat-ai pipeline.")
    parser.add_argument("cases", type=Path, help="JSONL file; each line is a chat turn request body")
    parser.add_argument("--out", type=Path, default=None, help="write results here instead of stdout")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args.cases, args.out, args.limit)))


if __name__ == "__main__":
    main()
