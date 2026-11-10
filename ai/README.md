# ai — chat-ai

채팅 응답 생성과 대화 요약을 맡는 `chat-ai`입니다. 백엔드(`chat-server`)가 HTTP로 부르고, 이 서버는 모델 API를 호출해 결과를 돌려줍니다. 상태를 저장하지 않습니다. 제품 스펙은 `test-chat-spec/DOMAIN/CHAT/AI/`에 있습니다.

## 구조

```
요청 → 라우터 → 응답 생성 모듈 → 프롬프트 조립 ← prompt/chat.md
                       ↓
                 공통 LLM 호출 ← config/models.yaml (경로 → 제공사·모델·옵션)
                       ↓
                 제공사 어댑터 (anthropic, openai, openrouter, fake) → 모델 API
```

| 바꾸고 싶은 것 | 고치는 곳 | 코드 변경 |
|---|---|---|
| 모델, 제공사, 토큰 한도, 호출 한도 | `config/models.yaml` | 없음 |
| 프롬프트 | `prompt/chat.md`, `prompt/compact.md` 내용과 맨 위 머리말의 `version` | 없음 |
| 새 제공사 | `src/chat_ai/llm/adapters/` 에 어댑터 1개 추가 | 있음 |

- 경로 이름은 `chat_general`, `chat_adult`, `compact` 세 개로 고정. 코드는 이름만 알고 실제 모델은 yaml이 정합니다.
- 프롬프트 템플릿은 `<!-- system -->`(필수)과 `<!-- user -->` 구역, `{{name}}` 치환, `{{#summary}}…{{/summary}}`(값이 있을 때만), `{{^is_adult}}…{{/is_adult}}`(없을 때만) 블록을 씁니다. 파일 맨 위 머리말(`---` 사이)의 `version: chat_v1`이 템플릿 버전입니다. 내용을 고치면 `version`도 올립니다(CI가 버전 그대로인 수정은 막음). 버전별 내용은 git 기록으로 봅니다.
- 제공사 SDK는 어댑터 안에서만 import 합니다(테스트가 검사).

## 로컬 실행

```bash
cd ai
python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# 1) API 키 없이 (고정 답변)
MODELS_CONFIG_PATH=config/models.fake.yaml .venv/bin/uvicorn chat_ai.app:app --port 8100

# 2) 실제 모델: ai/.env.local 에 ANTHROPIC_API_KEY=... 를 적고
.venv/bin/uvicorn chat_ai.app:app --port 8100

curl http://127.0.0.1:8100/health
```

백엔드를 여기에 붙이려면 `backend/.env.local`에 `AI_MODE=http`(기본 주소 `http://127.0.0.1:8100`)를 적고 chat-server를 다시 띄웁니다.

## 테스트와 검사

```bash
.venv/bin/pytest -q            # 외부 호출 없음. 가짜 어댑터로 계약·오류·취소를 검사
.venv/bin/ruff check src tests && .venv/bin/mypy
```

## 평가

운영과 같은 조립·호출 코드로 돌립니다. 입력 파일은 한 줄에 채팅 턴 요청 본문(5-2) 하나인 JSONL입니다.

```bash
.venv/bin/chat-ai-eval datasets/cases.jsonl --out runs/$(date +%F).jsonl
```

`runs/`는 git에 넣지 않습니다. 벤치마크 데이터와 지표는 스펙 6-4, 6-5를 채우면서 정합니다.

## 환경 변수

로컬은 `ai/.env.local`(git 제외), 운영은 Railway 환경 변수입니다. 모델 경로는 환경 변수가 아니라 `config/models.yaml`입니다.

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | 없음 | `models.yaml`에 그 제공사(`anthropic`, `openai`, `openrouter`) 경로가 있으면 필수. 없으면 기동 실패 |
| `MODELS_CONFIG_PATH` | `config/models.yaml` | 경로 파일 위치. `config/models.fake.yaml`이면 키 없이 동작 |
| `PROMPT_DIR` | `prompt` | 템플릿 폴더 |
| `PORT` | `8100` | 수신 포트. Railway가 넣어 줌 |
| `APP_ENV` | `dev` | `dev` 또는 `prod`. `POSTHOG_API_KEY`가 있으면 필수. 없거나 다른 값이면 기동 실패 |
| `APP_RELEASE` | `RAILWAY_GIT_COMMIT_SHA` 또는 `local` | PostHog AI 호출 기록과 오류 보고의 `app_release` |
| `CHAT_REQUEST_TIMEOUT_SECONDS` | `90` | 채팅 요청 전체 한도. 넘으면 `failed` `timeout` |
| `COMPACT_REQUEST_TIMEOUT_SECONDS` | `60` | 요약 요청 전체 한도. 넘으면 502 `timeout` |
| `POSTHOG_API_KEY`, `POSTHOG_HOST` | 없음 | 있으면 요청마다 AI 호출 기록(`$ai_trace`, `$ai_span`, `$ai_generation`)과 내부 오류 전송. 요청 헤더 `X-Account-Id`가 `distinct_id` |

## 배포

Railway가 `ai/Dockerfile`로 이미지를 만듭니다. 이미지에 `config/`와 `prompt/`가 들어가므로 모델·프롬프트 변경은 커밋 → push → 재배포입니다. 종료 유예는 120초(채팅 한도 90초보다 길게).

## 아직 없는 것

- 성인 모드 제공사. `chat_adult`는 일반과 같은 모델을 가리킵니다. 제공사가 정해지면 어댑터 1개와 yaml 한 줄.
- 평가 데이터셋과 지표(스펙 6-4, 6-5, 6-6 비어 있음).
- 실제 PostHog 프로젝트에 붙여 본 적 없음. 키가 없으면 꺼진 채 뜹니다.
