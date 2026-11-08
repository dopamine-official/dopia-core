# dopia

프론트엔드, 백엔드, AI 서비스를 구분하는 모노레포입니다. 제품 스펙은 별도 `test-chat-spec` 저장소에서 관리합니다.

## 구조

```text
dopia/
├── frontend/             # Next.js 앱, 브라우저용 모의 API, 테스트
├── backend/              # chat-server (Kotlin, Spring Boot, PostgreSQL)
├── ai/                   # chat-ai (Python, FastAPI) — 응답 생성·요약
├── .github/workflows/    # 저장소 CI
├── package.json          # 루트 실행·검사 명령
├── pnpm-workspace.yaml   # JavaScript 워크스페이스
└── pnpm-lock.yaml        # 공통 의존성 잠금 파일
```

`frontend`는 기본으로 브라우저 안의 모의 API(`frontend/src/mocks/`)로 동작하고, `backend`의 실제 서버에 붙일 수도 있습니다. AI 서버는 `ai/`의 chat-ai이며, 백엔드는 기본으로 고정 답변(stub)을 쓰고 `AI_MODE=http`일 때 chat-ai를 호출합니다. ([ai README](ai/README.md)) 각 서비스의 의존성·실행·배포 설정은 각각의 폴더에서 관리합니다.

## 실행과 검사

Node.js 20.9 이상이 필요합니다. 아래 명령은 저장소 루트에서 실행합니다.

```bash
# 새 환경에서 의존성 설치
npx pnpm@10.28.2 install --frozen-lockfile

npm run dev             # http://127.0.0.1:3000
npm run check           # i18n, TypeScript, 단위·HTTP 테스트
npm run build           # 프론트 프로덕션 빌드
npm run start           # 빌드한 프론트 실행
npm run test:e2e         # 데스크톱·모바일 브라우저 테스트 (모의 API)
```

실제 서버로 실행하려면 먼저 백엔드를 띄웁니다. ([백엔드 README](backend/README.md))

```bash
npm run dev:server       # 웹 → http://127.0.0.1:8080 의 chat-server로 프록시
npm run test:e2e:server  # 같은 E2E를 실제 서버로 실행
```

루트 명령은 `frontend/package.json`의 스크립트로 전달됩니다. `frontend/` 안에서도 같은 명령을 실행할 수 있습니다. 예를 들어 `npm run test:e2e -- --list`로 브라우저 테스트 목록을 확인합니다.

새 환경의 E2E 브라우저 설치:

```bash
npx pnpm@10.28.2 --dir frontend exec playwright install chromium
```

폴더 이동 전에 실행한 개발 서버가 있다면 해당 터미널에서 `Ctrl+C`로 종료한 뒤 루트에서 `npm run dev`를 다시 실행합니다.

구현 범위, 언어 설정, 모의 API 동작과 검증 상태는 [프론트엔드 README](frontend/README.md)에 있습니다.
