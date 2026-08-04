# claude-sessions

PC에서 **여러 Claude Agent SDK 세션을 풀로 띄워두고**, 폰/다른 기기 브라우저에서
**모니터링 · Yes/No 승인 · 새 명령 주입**을 하는 원격 멀티세션 컨트롤러.
스크린샷·UI 자동화 없이 SDK 1급 기능(스트리밍 입력 / `canUseTool` / 입력 주입)으로 동작한다.

설계 배경은 [DESIGN.md](DESIGN.md) 참고.

## 실행

```powershell
pnpm install
# 토큰을 직접 지정하거나(권장), 생략하면 서버가 랜덤 발급해 콘솔에 출력
$env:SCREEN_TOKEN = '원하는토큰'
pnpm start            # tsx src/server.ts
```

콘솔에 LAN 접속 주소(`http://<PC-IP>:8787`)와 토큰이 표시된다.
폰 브라우저로 그 주소를 열고 **토큰을 입력**하면 접속된다. (PC와 폰이 같은 WiFi 여야 함)

### 비번별 폴더 샌드박스 (다계정)

비번마다 접근 가능한 폴더를 다르게 줄 수 있다. **비번·폴더 같은 값은 `.env` 에 적는다**(gitignore 됨 — 소스에 비밀값을 넣지 않음). `.env.example` 을 복사해 시작:

```powershell
Copy-Item .env.example .env
```

`.env` 형식 — 계정마다 한 줄, `비번|접근폴더|이름`:

```dotenv
SCREEN_ACCOUNT_1=work123|C:\proj\work|업무
SCREEN_ACCOUNT_2=home|D:\personal|개인
SCREEN_ACCOUNT_3=admin!||전체
```

- 1번부터 연속으로 읽는다(빈 번호를 만나면 멈춤). `접근폴더`를 비우면 **전체 접근**(무제한).
- 그 비번으로 로그인하면 **① 폴더 탐색·새 세션 생성이 그 폴더 안으로만 제한**되고(밖은 403), **② 세션 안의 에이전트 도구(Read/Write/Bash 등)도 루트 밖 파일 접근이 차단**된다(위험 모드여도 적용).
- 규칙은 부팅 시 1회 읽으므로 바꾸면 **서버를 재시작**해야 한다.
- Bash의 상대경로 탈출까지 완벽히 막지는 못한다(절대경로 검사 + 프롬프트 안내로 방어). 완전 격리는 OS 레벨/컨테이너가 필요.
- `SCREEN_ACCOUNT_*` 이 하나도 없으면 `SCREEN_ACCESS`(JSON) → 단일 `SCREEN_TOKEN` 순으로 폴백한다.

> 파싱 로직은 `src/accounts.ts`(`.env` 를 읽어 규칙으로) 에 있다 — 값이 아니라 로직만 코드에 둔다.

환경변수(전부 `.env` 에 넣을 수 있음):
- `SCREEN_TOKEN` — 단일 접속 토큰 (없으면 랜덤). `SCREEN_ACCOUNT_*` 이 있으면 무시된다.
- `PORT` — 기본 8787
- `HOST` — 기본 `0.0.0.0` (LAN 노출)

## 사용 흐름

1. 폰에서 **+ 새 세션** → 작업 폴더(cwd) 입력 → 생성. 폴더당 세션 하나, 프로젝트별로 관리.
2. 입력창에 명령을 적어 전송 → 세션이 작업(`thinking`).
3. 도구가 승인을 필요로 하면 상단에 **승인 배너**가 뜨고 상태가 `승인대기`로 바뀐다 → **Yes/No** 탭.
4. 결과가 나오면 `대기(idle)` → 다음 명령을 이어서 주입.

> 안전한 읽기 명령(`echo`, `ls`, 파일 읽기 등)은 SDK 분류기가 자동 허용하므로 폰에 뜨지 않는다.
> 파일 쓰기·위험한 bash·네트워크 등 **승인이 필요한 작업만** 폰으로 라우팅된다.

## 권한 처리

각 세션은 `settingSources: ['project']` 로 띄운다 — 전역 `~/.claude/settings.json` 의
allow 규칙을 상속하지 않아 모든 승인이 `canUseTool`(=폰)로 강제되고, 프로젝트 CLAUDE.md 는 로드된다.
기본 정책은 거부(폰이 No 하거나 세션이 중단되면 deny).

## 구조

```
src/
  server.ts          HTTP + WebSocket 기동, LAN IP 출력
  sessionManager.ts  세션 풀 관리 + broadcast
  session.ts         SDK query() 래퍼 (입력큐 + canUseTool + 스트림 소비)
  permissions.ts     requestId ↔ resolver 레지스트리
  asyncQueue.ts       스트리밍 입력 큐
  api.ts / ws.ts / auth.ts / ids.ts / types.ts
web/                 폰 UI (의존성 없는 바닐라 HTML/JS/CSS)
```

## REST API (토큰 헤더 `Authorization: Bearer <TOKEN>`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/sessions` | 세션 목록 |
| POST | `/api/sessions` | 새 세션 `{cwd, title?}` |
| GET | `/api/sessions/:id` | 세션 상세 |
| POST | `/api/sessions/:id/prompt` | 명령 주입 `{text}` |
| POST | `/api/sessions/:id/approve` | 승인/거부 `{requestId, decision}` |
| POST | `/api/sessions/:id/interrupt` | 진행 중 턴 중단 |
| DELETE | `/api/sessions/:id` | 세션 종료 |

WebSocket `/ws?token=<TOKEN>` — `snapshot` / `session_update` / `session_removed` 푸시.

## 보안

LAN 전용 + bearer 토큰이 1차 범위. 외부 인터넷 노출은 별도 단계(터널/추가 인증).
이 서버는 PC에서 도구를 실행할 권한이 있으므로 신뢰된 네트워크에서만 사용할 것.
