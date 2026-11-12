# backend — chat-server

계정(ACCOUNT)·캐릭터(CHARACTER)·대화(CHAT) API와 데이터 저장을 담당하는 `chat-server`입니다. 제품 스펙은 별도 `test-chat-spec` 저장소의 `DOMAIN/*/BE/`에 있고, 기술 결정은 `TBD.md` 10절에 있습니다.

## 기술

- Kotlin + Spring Boot 4, JDK 21 이상. Gradle Wrapper(`./gradlew`)로 빌드하며 Gradle 설치는 불필요
- PostgreSQL + Flyway. 마이그레이션(`src/main/resources/db/migration`)은 서버 기동 시 적용
- API JSON 필드와 DB 테이블·컬럼은 모두 snake_case (Jackson `SNAKE_CASE` 전역 설정)
- 패키지: `account`, `character`, `chat`(+`chat/ai`), `common`, `config`, `dev`(dev 프로파일 전용)

## 로컬 실행

```bash
cd backend
docker compose up -d                      # PostgreSQL 17, 127.0.0.1:5432
SPRING_PROFILES_ACTIVE=dev ./gradlew bootRun   # http://127.0.0.1:8080
curl http://127.0.0.1:8080/actuator/health
```

`dev` 프로파일은 샘플 캐릭터 4개(`db/dev/R__dev_characters.sql`)를 넣고, 웹 미리보기 페이지용 `/api/v1/mock/*` 엔드포인트(로그인·시나리오·이벤트·초기화)를 켜며, 쿠키의 `Secure`를 끕니다.

웹을 실제 서버에 붙이려면 저장소 루트에서 `npm run dev:server`, E2E는 `npm run test:e2e:server`로 실행합니다. 웹의 `/api/v1/*`가 이 서버로 프록시됩니다.

## 테스트

```bash
./gradlew test    # Testcontainers로 PostgreSQL을 띄우므로 Docker 필요
```

## 환경 변수

로컬에서는 `backend/.env.local`(git 제외)에 적으면 기동 시 자동으로 읽습니다. 운영에서는 Railway 환경 변수로 넣습니다.

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `DB_URL`, `DB_USERNAME`, `DB_PASSWORD` | 로컬 Docker DB | Supabase로 바꿀 때 이 셋만 교체 |
| `PORT` | `8080` | HTTP 포트 |
| `COOKIE_SECURE`, `COOKIE_DOMAIN` | `true`, 없음 | 쿠키 속성. dev 프로파일은 `false` |
| `SESSION_TTL` | `30d` | 세션 수명 |
| `PHOTO_MAX_BYTES` | `2097152` | 프로필 사진 상한 |
| `DATABASE_URL` | 없음 | Supabase의 접속 문자열(URI). 있으면 위 셋 대신 사용. 로컬 Mac은 IPv6가 없어 `db.….supabase.co` 직접 주소가 안 되므로 **Session pooler** 주소(`postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432`)를 씁니다 |
| `STORAGE_DIR`, `STORAGE_PUBLIC_BASE_URL` | `./data/photos`, `/files` | 로컬 디스크 사진 저장소 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | 없음 | Cloudflare R2 사진 저장소. `R2_BUCKET`이 있으면 디스크 대신 사용 |
| `AI_MODE`, `AI_BASE_URL`, `AI_TIMEOUT` | `stub`, `http://127.0.0.1:8100`, `90s` | `http`로 바꾸면 `ai/`의 chat-ai를 호출. chat-ai 실행법은 [ai README](../ai/README.md) |
| `TURN_MAX_CONCURRENT` | `64` | 동시 생성 한도, 초과 시 503 `server_busy` |
| `HOME_CACHE_TTL` | `60s` | 홈 목록 캐시 |
| `REGION_PROFILE` | `development` | region config 프로파일 (`src/main/resources/i18n`) |
| `INSTANCE_ID` | `HOSTNAME` 또는 `local` | 턴을 받는 인스턴스 식별자 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 없음 | Google 로그인. 비어 있으면 로그인 시작이 `/login?error=login_failed`로 돌아감 |
| `OAUTH_REDIRECT_BASE_URL` | `http://127.0.0.1:3000` | 브라우저가 이 API에 닿는 origin. 콜백 주소 `{여기}/api/v1/account/auth/{provider}/callback` |
| `WEB_BASE_URL` | `http://127.0.0.1:3000` | 로그인 뒤 돌아갈 웹 origin |
| `LOGIN_STATE_KEY` | dev용 고정값 | `login_state` 쿠키 서명 키. 운영에서는 반드시 교체 |
| `POSTHOG_API_KEY`, `POSTHOG_HOST` | 없음, `https://us.i.posthog.com` | 서버 이벤트(TRACKING-PLAN 8)를 PostHog로 보냄. 키가 없으면 보내지 않음. chat-ai와 같은 변수 |
| `APP_RELEASE` | `RAILWAY_GIT_COMMIT_SHA` 또는 `local` | 서버 이벤트의 `app_release` |

## Google 로그인 설정

1. [Google Cloud 콘솔](https://console.cloud.google.com/apis/credentials)에서 OAuth 클라이언트 ID(웹 애플리케이션)를 만듭니다.
2. 승인된 리디렉션 URI에 `http://127.0.0.1:3000/api/v1/account/auth/google/callback`을 추가합니다. 웹의 프록시를 거치므로 포트는 웹(3000)입니다.
3. 서버를 `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… SPRING_PROFILES_ACTIVE=dev ./gradlew bootRun`으로 띄우고, 웹은 루트에서 `npm run dev:server`로 띄웁니다. `dev:server`는 로그인 버튼을 실제 OAuth 흐름(`NEXT_PUBLIC_LOGIN=oauth`)으로 연결합니다.

E2E(`npm run test:e2e:server`)는 외부 제공사 없이 돌도록 dev 전용 `/mock/login`을 계속 씁니다. 서버 쪽 로그인 검증은 `GoogleLoginTest`가 가짜 Google 서버와 테스트 키로 서명한 ID 토큰으로 수행합니다.

## 아직 없는 것

- PAYMENT. 턴의 `charge_type`만 기록하고 차감·환급은 없습니다.
- 대화 요약(compact). `chat_summaries` 테이블만 있고 요약 요청은 하지 않습니다.
- PostHog·Langfuse. 이벤트는 메모리에만 남겨 미리보기 페이지에 보여줍니다. feature flag `adult_characters_visible`은 항상 `true`로 봅니다.
- 명세의 TBD 값(닉네임 길이, 요청 제한 등)은 웹 모의 서버의 값을 그대로 씁니다.
