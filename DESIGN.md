# claude-sessions — 원격 멀티세션 Claude 컨트롤러 설계도

## 0. 한 줄 정의

PC에서 **여러 Claude Agent SDK 세션을 풀(pool)로 띄워두고**, 폰/다른 기기 브라우저에서
**① 각 세션 상태를 보고 ② Yes/No를 승인하고 ③ 새 명령을 주입**하는 시스템.
스크린샷·UI 자동화 없음. 전부 SDK의 1급 기능(스트리밍 / canUseTool / 입력 주입)으로.

---

## 1. 전체 구성도

```
┌──────────────────────────── PC (서버) ────────────────────────────┐
│                                                                    │
│   ┌─────────────────────────────────────────────────────────┐     │
│   │                  Web/API 서버 (HTTP + WebSocket)          │     │
│   │   · 정적 폰 UI 서빙   · REST   · WS 푸시(상태/스트림)      │     │
│   └───────────────┬─────────────────────────▲────────────────┘     │
│                   │ 명령(생성/프롬프트/승인)  │ 이벤트(스트림/상태)  │
│           ┌───────▼─────────────────────────┴────────┐             │
│           │            Session Manager                │             │
│           │   세션 풀 보관 · 생성/종료 · 상태 집계      │             │
│           └───┬──────────────┬──────────────┬─────────┘             │
│        spawn  │              │              │                       │
│       ┌───────▼──┐    ┌──────▼───┐   ┌──────▼───┐                   │
│       │ Session A │    │ Session B│   │ Session C│   ← SDK query()   │
│       │ cwd=budget│    │ cwd=math │   │ cwd=tax  │     루프 each     │
│       │ inputQ ───┼─┐  │          │   │          │                   │
│       │ canUseTool│ │  │          │   │          │                   │
│       └───────────┘ │  └──────────┘   └──────────┘                   │
│                     └─ 새 메시지를 큐에 push → 세션이 소비            │
└────────────────────────────────────────────────────────────────────┘
                          ▲ 같은 WiFi/LAN (토큰 인증)
                          │
        ┌─────────────────┴──────────────────┐
        │           폰 / 태블릿 브라우저        │
        │  세션목록[A·B·C]  상태뱃지            │
        │  [선택] → 스트리밍 로그              │
        │  권한대기 시: [Yes][No]              │
        │  입력창: "다음엔 이거 해" → 전송      │
        └────────────────────────────────────┘
```

핵심 4개 컴포넌트:
- **Session Manager** — 세션 풀의 생성/종료/상태를 관리하는 코어
- **Session** — SDK `query()` 한 개 = 작업 한 줄기 (cwd·맥락·입력큐·권한콜백 보유)
- **Web/API 서버** — REST + WebSocket, 폰 UI 서빙
- **폰 UI** — 브라우저 클라이언트 (설치 불필요)

---

## 2. 핵심 데이터 모델

```ts
type SessionStatus =
  | 'starting'            // 프로세스 기동 중
  | 'idle'                // 입력 대기 (사용자 턴)
  | 'thinking'            // Claude 작업/응답 생성 중
  | 'awaiting_permission' // 도구 실행 직전, Yes/No 대기
  | 'done'                // 턴 완료
  | 'error';

interface PendingPermission {
  requestId: string;      // 승인 1건 식별자
  toolName: string;       // 예: "Bash"
  input: unknown;         // 도구 입력(명령 텍스트 등)
  suggestions?: unknown;  // SDK가 주는 권한 제안(있으면)
}

interface Session {
  id: string;             // 세션 식별자 (= SDK sessionId 연동)
  title: string;          // 표시용 (프로젝트명 등)
  cwd: string;            // 작업 폴더 = 프로젝트
  status: SessionStatus;
  messages: StreamItem[]; // 스트리밍된 출력 누적(폰에 표시)
  pending?: PendingPermission;
  createdAt: string;
}
```

---

## 3. 세션 운영 메커니즘 (지속 세션 + 입력 주입)

SDK는 `prompt`로 **AsyncIterable**을 받으면 "스트리밍 입력 모드"가 되어 **세션이 죽지 않고 여러 턴**을 받는다.
우리는 세션마다 **입력 큐**를 두고, 폰이 보낸 새 명령을 큐에 push하면 세션이 그걸 소비한다.

```ts
// 세션 하나 = query() 루프 하나 (의사코드, 주석은 한국어)
function startSession(opts: { id; cwd; title }) {
  const inputQueue = new AsyncQueue<SDKUserMessage>();   // 폰이 밀어넣는 입력 큐

  const run = query({
    prompt: inputQueue.iterator(),                       // 스트리밍 입력 → 지속 세션
    options: {
      cwd: opts.cwd,                                     // 프로젝트 폴더
      // 도구 실행 직전 가로채기 → 폰으로 Yes/No 라우팅
      canUseTool: async (toolName, input) => {
        const requestId = newId();
        setStatus(opts.id, 'awaiting_permission', { requestId, toolName, input });
        broadcast(opts.id);                              // 폰에 "권한 대기" 푸시
        const decision = await waitForDecision(requestId); // 폰 응답까지 대기
        return decision === 'yes'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '사용자가 거부함' };
      },
    },
  });

  // 출력 스트림 → 누적 + 폰 푸시
  (async () => {
    for await (const msg of run) {
      appendMessage(opts.id, msg);
      updateStatusFromMessage(opts.id, msg);             // thinking/done 등 갱신
      broadcast(opts.id);
    }
  })();

  return { id: opts.id, inputQueue };
}

// 폰이 "새 명령"을 보내면:
function sendPrompt(sessionId, text) {
  pool[sessionId].inputQueue.push(userMessage(text));    // 큐에 넣으면 세션이 소비
}
```

> 결정 포인트: SDK가 스트리밍 입력 모드를 지원하지 않거나 제약이 있으면,
> 폴백으로 **턴마다 `resume`(직전 sessionId 이어받기)** 방식으로 새 query를 띄운다. 1차 구현 때 검증.

---

## 4. 권한 승인 흐름 (sequence)

```
세션          서버(canUseTool)        WebSocket        폰
  │ 도구 실행 직전 │                      │              │
  │──canUseTool──▶│ pending 등록          │              │
  │              │ status=awaiting       │              │
  │              │──broadcast───────────▶│──"권한대기"──▶│  [Yes][No] 표시
  │              │ (await decision)      │              │
  │              │                       │◀──POST /approve {requestId, yes}──│ 탭
  │              │◀──resolve(yes)────────│              │
  │◀─allow/deny──│                       │              │
  │ 실행/거부     │ status=thinking       │──상태갱신───▶│
```

`requestId → resolver(Promise)` 맵으로 비동기 대기/해소.

---

## 5. 새 명령 주입 흐름 (sequence)

```
폰                       서버                     세션
 │ 입력창 "다음엔 X 해"     │                        │
 │──POST /sessions/A/prompt──▶ inputQueue.push(X) ──▶│ 다음 턴으로 X 소비
 │                         │ status=thinking        │
 │◀────WS: 스트리밍 출력─────────────────────────────│
```

---

## 6. 세션 상태 머신

```
 starting ─▶ idle ─(프롬프트)─▶ thinking ─┬─(도구필요)─▶ awaiting_permission
                ▲                         │                    │
                │                         │              Yes─▶ thinking
                │                         │              No ─▶ thinking(거부 반영)
                └──────(턴 완료)── done ◀──┘
   error: 어느 상태에서든 예외 시
```

---

## 7. API / WebSocket 프로토콜 (초안)

REST (전부 토큰 헤더 필요):
```
GET    /api/sessions                  → 세션 목록 + 상태
POST   /api/sessions      {cwd,title} → 새 세션 spawn
DELETE /api/sessions/:id              → 세션 종료
POST   /api/sessions/:id/prompt {text}→ 새 명령 주입
POST   /api/sessions/:id/approve {requestId, decision:'yes'|'no'} → 승인/거부
GET    /api/sessions/:id              → 단일 세션 상세(메시지 포함)
```

WebSocket (서버 → 폰 푸시):
```
{ type:'session_update', session: Session }     // 상태/메시지 변경
{ type:'permission_request', sessionId, pending } // 권한 대기 발생
{ type:'session_removed', sessionId }
```

---

## 8. 디렉토리 구조 (제안)

```
claude-sessions/
├─ DESIGN.md                  ← 이 문서
├─ package.json               (pnpm)
├─ tsconfig.json
├─ src/
│  ├─ server.ts               엔트리: HTTP+WS 기동
│  ├─ sessionManager.ts       세션 풀 관리
│  ├─ session.ts              SDK query() 래퍼 + 입력큐 + canUseTool
│  ├─ permissions.ts          requestId↔resolver 맵
│  ├─ api.ts                  REST 라우트
│  ├─ ws.ts                   WebSocket 허브(broadcast)
│  ├─ auth.ts                 토큰 검증
│  └─ types.ts                공용 타입
└─ web/                       폰 UI (정적)
   ├─ index.html
   ├─ app.js                  세션목록·로그·버튼·입력
   └─ style.css
```

---

## 9. 기술 스택 / 의존성

- **런타임**: Node.js + TypeScript
- **패키지매니저**: pnpm
- **SDK**: `@anthropic-ai/claude-agent-sdk`
- **HTTP/WS**: 가벼운 조합 — `express`(또는 내장 http) + `ws`
- **테스트**: vitest
- **폰 UI**: 1차는 의존성 없는 바닐라 HTML/JS (e-ink/구형 브라우저 호환). 추후 필요 시 프레임워크.

---

## 10. 보안 (LAN 전용 1차)

- 서버는 사실상 "내 PC를 원격 조작"하는 권한 → **반드시 인증**.
- 1차: **bearer 토큰**(서버 시작 시 발급, 폰에 1회 입력) + LAN 전용 바인딩.
- 외부 인터넷 노출은 별도 단계(터널/추가 인증). 1차 범위 밖.
- canUseTool 기본정책: **모르면 deny** (명시 승인만 allow).

---

## 11. 단계별 구현 로드맵

- **Phase 1 — 코어 1세션**: SDK로 세션 1개 띄우고 CLI/로컬에서 프롬프트→스트림→canUseTool 콘솔 승인까지 검증. (스트리밍 입력 모드 실증)
- **Phase 2 — 서버화**: Session Manager + REST + WS. 세션 풀 N개.
- **Phase 3 — 폰 UI**: 목록/상태뱃지/스트리밍 로그/[Yes][No]/입력창.
- **Phase 4 — 인증·정리**: 토큰, 세션 종료/에러 처리, 재기동 resume.

---

## 12. 미결정 / 결정 포인트

1. 스트리밍 입력 모드 지원 범위 → Phase 1에서 실증 (안 되면 resume 폴백).
2. 세션 메시지 영속화 필요? (서버 재시작 후 복원) — 1차는 in-memory + SDK resume.
3. 폰 UI 프레임워크 — 1차 바닐라 확정, 추후 검토.
4. 외부 인터넷 접속 — 1차 제외.
