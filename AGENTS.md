# dopia-core

웹(`frontend/`), 채팅 서버(`backend/`), AI 서버(`ai/`)를 담은 저장소임. 제품 명세는 별도 저장소 `dopia-spec`에 있음.

<br>

## 1. 브랜치

| 브랜치 | 용도 | 규칙 |
|---|---|---|
| `main` | 배포 기준 | 직접 push 금지<br>`release` 브랜치에서 PR로만 머지함 |
| `dev` | 개발 통합 | `feat`, `fix`, `docs` 브랜치를 머지함 |
| `feat` | 기능 추가 | `dev`에서 분기해 `dev`로 머지함<br>`feat/posthog-web` |
| `fix` | 버그 수정 | `dev`에서 분기해 `dev`로 머지함<br>`fix/turn-drain` |
| `docs` | 문서, 설정 변경 | `dev`에서 분기해 `dev`로 머지함<br>`docs/git-convention` |
| `release` | 배포 준비 | `dev`에서 분기해 `main`으로 머지함<br>`release/0.1.0` |

- 브랜치 종류는 위 네 가지만 사용함.
- 브랜치명은 작업 내용을 바로 알 수 있게, 간결하고 직관적으로 지음.
- 머지하면 로컬과 원격 브랜치는 삭제함.
- `main` 직접 push는 로컬 `pre-push` 훅이 차단함. 비공개 저장소 무료 플랜은 GitHub 브랜치 보호를 지원하지 않음.

<br>

## 2. 커밋 메시지

`종류(범위): 요약` 형식으로 작성함.

```text
feat(web): 404 화면 이벤트 추가
fix(backend): 턴 중단 시 스트림을 끝까지 읽지 않음
```

| 종류 | 대상 |
|---|---|
| `feat` | 기능 추가 |
| `fix` | 버그 수정 |
| `refactor` | 동작 변화 없는 구조 변경 |
| `test` | 테스트만 변경 |
| `docs` | 문서만 변경 |
| `style` | 포맷만 변경 |
| `chore` | 설정, 의존성, 빌드, CI |

| 범위 | 폴더 |
|---|---|
| `web` | `frontend/` |
| `backend` | `backend/` |
| `ai` | `ai/` |
| `ci` | `.github/` |
| 생략 | 여러 폴더에 걸친 변경 |

- 요약은 한국어로 50자 안쪽에서 무엇을 바꿨는지 작성함.
- 이유가 필요하면 한 줄을 비우고 본문에 작성함.
- 커밋 하나에는 변경 하나만 담음. 포맷 변경과 동작 변경을 섞지 않음.

<br>

## 3. PR

- 제목은 커밋 메시지 형식을 따름.
- 본문에는 무엇을 왜 바꿨는지, 어떻게 확인했는지 작성함.
- CI가 통과한 뒤 머지함.
- `dev`로는 squash merge, `main`으로는 merge commit을 사용함.

<br>

## 4. 코드 스타일

코드 스타일은 도구가 정하고 문서로 정하지 않음. 커밋 전에 아래 검사를 통과해야 함. CI도 같은 검사를 실행함.

| 폴더 | 도구 | 자동 수정 | 검사 |
|---|---|---|---|
| `frontend/` | ESLint, Prettier | `npm run format` | `npm run check` |
| `backend/` | ktlint | `./gradlew ktlintFormat` | `./gradlew build` |
| `ai/` | ruff, mypy | `ruff format src tests` | `ruff check src tests && ruff format --check src tests && mypy` |
