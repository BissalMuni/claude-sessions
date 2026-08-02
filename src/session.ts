import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncQueue } from './asyncQueue.js';
import { isDanger } from './dangerMode.js';
import { shortId } from './ids.js';
import { registerPermission, registerQuestion, rejectSessionPermissions } from './permissions.js';
import { offendingToolPath } from './toolGuard.js';
import type {
  ContextUsage,
  InputImage,
  PendingPermission,
  PendingQuestion,
  QuestionSpec,
  SessionStatus,
  SessionView,
  StreamItem,
} from './types.js';

const MAX_MESSAGES = 300; // 폰 메모리 보호: 최근 N개만 유지

// 위험 모드는 런타임 토글(dangerMode.ts)로 관리한다. 켜지면 AskUserQuestion(프로젝트
// 방향 결정)을 제외한 모든 도구를 폰에 묻지 않고 자동 허용한다. 기본은 ON.
// canUseTool 안에서 isDanger() 를 매 호출마다 읽으므로, 폰 스위치로 즉시 반영된다.

// 모든 세션에 공통 주입되는 "헌법". Claude Code 프리셋 시스템 프롬프트에 append 된다.
// 핵심: 프로젝트 방향에 영향을 주는 결정에서는 임의로 진행하지 말고 AskUserQuestion 으로 물어라.
const CONSTITUTION = [
  '## 운영 헌법 (claude-sessions)',
  '너는 사용자가 여러 디바이스(폰·데스크톱 등)로 원격 감시하는 자율 세션이다. 다음을 항상 지켜라:',
  '- 프로젝트 방향에 영향을 주는 결정에 부딪히면 임의로 진행하지 말고 `AskUserQuestion` 으로 사용자에게 물어라.',
  '  해당: 아키텍처/기술 선택, 요구사항이 모호하거나 해석이 갈릴 때,',
  '  비가역적·위험한 작업(데이터/파일 삭제, force push, 배포, 시스템 설정 변경, 재부팅),',
  '  작업 범위가 크게 늘어나는 변경.',
  '- 그 외 일상적인 읽기·탐색·빌드·편집은 멈추지 말고 진행하라.',
  '- 질문할 때는 선택지를 구체적으로 제시하고 첫 번째에 권장안을 둬라.',
  '- `AskUserQuestion` 은 **한 번에 질문 1개만** 보내라. 한 호출에 질문을 여러 개 묶으면',
  '  웹 UI 가 각 선택마다 리프레시되어 사용자가 끝까지 답할 수 없다. 질문 수 자체를',
  '  줄이라는 게 아니라, 결정이 여러 개면 묶지 말고 하나씩 순차로 물어 화면 리프레시를 피하라.',
  '- 프로세스를 정리할 때 `taskkill /IM node.exe`, `pkill node`, `killall node` 처럼',
  '  **이름으로 모든 node 프로세스를 죽이지 마라.** 너를 감시하는 이 컨트롤러 서버도 node 라서',
  '  함께 죽어 전체가 중단된다. 반드시 포트나 특정 PID 만 종료하라',
  '  (예: `netstat -ano | findstr :3000` 으로 PID 를 찾아 `taskkill /F /PID <그 PID>`).',
].join('\n');

// 위험 모드일 때만 덧붙이는 경고. 도구가 자동 실행되므로 질문이 유일한 안전장치임을 명시.
const DANGER_NOTE = [
  '',
  '## 위험 모드 안내',
  '현재 모든 도구는 사용자 승인 없이 자동 실행된다.',
  '따라서 위 "방향 결정 시 질문" 규칙이 사용자가 개입할 수 있는 유일한 안전장치다.',
  '특히 비가역적·위험한 작업을 실행하기 전에는 반드시 먼저 `AskUserQuestion` 으로 확인하라.',
].join('\n');

// 폴더 샌드박스(제한 계정) 세션에 덧붙이는 안내. canUseTool 이 도구 호출을 차단하지만,
// Bash 상대경로 탈출 등 코드 검사가 완벽치 못한 틈을 프롬프트로도 겹쳐 막는다.
function sandboxNote(root: string): string {
  return [
    '',
    '## 폴더 샌드박스',
    `이 세션은 '${root}' 폴더 안에서만 작업해야 한다.`,
    '그 밖의 파일을 읽거나 쓰지 마라 — 서버가 루트 밖 경로의 도구 호출을 차단한다.',
  ].join('\n');
}

// 세션 시작 시점의 위험 모드에 맞춰 시스템 프롬프트 append 를 만든다.
// (이미 떠 있는 세션의 systemPrompt 는 바꿀 수 없으므로, 토글 이후 새로 만든
//  세션부터 경고가 반영된다. 게이트 동작 자체는 isDanger() 로 즉시 반영됨.)
function buildSystemAppend(root: string | null): string {
  const base = isDanger() ? `${CONSTITUTION}\n${DANGER_NOTE}` : CONSTITUTION;
  return root ? `${base}\n${sandboxNote(root)}` : base;
}

// 자동 컴팩션 임계값(토큰). 기본 ~190k(한도의 95%)는 너무 늦어, 컨텍스트가 200k까지
// 차오르며 매 턴 그 전체를 다시 읽어 토큰이 폭발했다. 이 값을 낮추면 SDK 가 일찍 압축한다.
// 특히 복원(resume)된 큰 세션은 첫 턴에서 이 임계값을 넘으므로 곧바로 자동 컴팩션된다.
// SDK 스키마 허용 범위는 100_000~1_000_000. 그 밖의 값은 안전하게 클램프한다.
const COMPACT_WINDOW = Math.min(
  1_000_000,
  Math.max(100_000, Number(process.env.SCREEN_COMPACT_WINDOW) || 100_000),
);

// 일시적 스트림 오류(네트워크 끊김·컴팩션 중 ECONNRESET·과부하 등) 자동 재시도 설정.
// 이전엔 이런 오류 하나로 세션이 곧장 'error' 로 죽어(consume 의 catch) 폰에서 다시
// 살릴 방법이 없었다. resume(sdkSessionId) 로 다시 붙어 지수 백오프로 N회까지 재시도한다.
const STREAM_MAX_RETRIES = Math.max(0, Number(process.env.SCREEN_STREAM_MAX_RETRIES) || 3);
const STREAM_RETRY_BASE_MS = Math.max(500, Number(process.env.SCREEN_STREAM_RETRY_BASE_MS) || 2000);

// 모든 세션이 공유하는 '부팅 직렬화' 게이트.
// Claude Code SDK 서브프로세스는 query() 를 만드는 순간이 아니라 "첫 사용자 입력"을
// 받을 때 비로소 부팅하며, 그 과정에서 공유 파일 ~/.claude.json 을 읽고 다시 쓴다
// (쓰기 완료 시점이 곧 system/init). 여러 세션이 거의 동시에 첫 프롬프트를 받으면 그
// 쓰기가 경쟁해 파일이 깨지고(JSON 손상) 그 뒤 부팅하는 세션들이 전부 죽는다
// (='같은 프로젝트 2개 이상 안 뜸'의 실제 원인).
// 그래서 '한 번에 하나씩 부팅'한다: 앞 세션이 init(=쓰기 완료)까지 올라온 뒤(또는 안전
// 백스톱 후) 다음 세션의 첫 프롬프트를 입력 큐에 흘려보낸다.
// 핵심: 게이트는 query() '생성'이 아니라 '첫 프롬프트 부팅'에 건다. 실제 쓰기 경쟁이
// 거기서 나기 때문. query() 는 입력이 없으면 서브프로세스를 안 띄우므로 즉시 만들어도 안전.
let bootChain: Promise<void> = Promise.resolve();
// 앞 세션이 init 을 못 받고 매달릴 때 뒤 세션들이 영영 막히지 않게 하는 안전 백스톱(ms).
// 실측 init 도달은 ~8초라 예전 기본 2.5초는 너무 짧아 게이트가 새서 경쟁이 났다.
// 정상 부팅은 init 이 일찍 풀어주므로 이 백스톱은 '진짜 매달린 부팅'에만 발동한다.
const BOOT_SETTLE_MS = Number(process.env.SCREEN_START_SETTLE_MS) || 25_000;

// 이 시간(ms)보다 오래 SDK 가 무응답이면 '정체?'로 표시한다. 끊지 않는다 — 보여주기만.
const STALL_HINT_MS = Number(process.env.STALL_HINT_MS) || 90_000;
// SDK 서브프로세스 stderr/디버그 로그를 세션별로 남길 디렉터리
const LOG_DIR = join(process.cwd(), 'logs');
// 모든 세션의 SDK 스트림 오류(=폰이 보는 "CLI 응답 에러")를 한 파일에 모아 남긴다.
// stderr(logs/<id>.log)로는 안 잡히는, for await 루프에서 던져진 예외를 여기서 포착한다.
const ERROR_LOG = join(LOG_DIR, 'errors.log');
// 응답 지연 진단: 턴마다 TTFT(첫 토큰까지)·총시간·컨텍스트 토큰·캐시 히트를 logs/perf.log 에
// 남기고, SCREEN_PERF=1 이면 폰 화면에도 한 줄로 보여준다(어디서 몇 초 걸리는지 실측용).
const PERF_LOG = join(LOG_DIR, 'perf.log');
const PERF_SHOW = process.env.SCREEN_PERF === '1';

// 로컬 스킬 플러그인(절대경로). src/ 든 dist/ 든 항상 설치 루트의 skills-plugin/ 을
// 가리킨다. 세션 cwd 와 무관하게 모든 세션에 같은 스킬 묶음을 주입하기 위함.
// (skills-plugin/skills 는 ~/.claude/skills 로의 junction)
const SKILLS_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills-plugin');

export interface SessionOpts {
  id: string;
  title: string;
  cwd: string;
  /** 계정 샌드박스 루트. null 이면 무제한. 도구가 이 폴더 밖 파일을 건드리면 차단한다. */
  root?: string | null;
  /** 세션 소유 계정 id. null/미지정이면 레거시/공유(모든 계정에 보임). */
  ownerId?: string | null;
  /** 상태가 바뀔 때마다 호출 (WebSocket broadcast 연결용) */
  onUpdate: (view: SessionView) => void;
  /** 복원용: 재기동 시 이어받을 SDK 세션 id (있으면 query 에 resume 로 전달) */
  resumeSessionId?: string | null;
  /** 복원용: 폰에 다시 보여줄 이전 대화 기록 */
  initialMessages?: StreamItem[];
  /** 복원용: 원래 생성/갱신 시각 (없으면 now) */
  createdAt?: string;
  updatedAt?: string;
  /**
   * 지연 복원: true 면 생성만 하고 SDK 서브프로세스는 띄우지 않는다(상태 '대기').
   * 첫 프롬프트/중단 등 실제 사용 시점에 start() 된다. 재기동 시 24개를 동시에 띄워
   * .claude.json 충돌·메모리 고갈로 전부 '오류'가 되던 문제를 막기 위함.
   */
  lazy?: boolean;
}

/** 하나의 Claude Agent SDK 세션 = 작업 한 줄기 */
export class Session {
  readonly id: string;
  private title: string;
  private cwd: string;
  private root: string | null;
  private ownerId: string | null;
  private onUpdate: (view: SessionView) => void;

  private status: SessionStatus = 'starting';
  private sdkSessionId: string | null = null;
  private messages: StreamItem[] = [];
  private pending: PendingPermission | null = null;
  private question: PendingQuestion | null = null;
  private error: string | null = null;
  private readonly createdAt: string;
  private updatedAt: string;

  // stall 감지: SDK 로부터 마지막으로 무언가 받은(혹은 입력을 주입한) 시각.
  private lastActivityAt = Date.now();
  private stalled = false;
  // broadcast 를 read loop 밖으로 빼기 위한 coalescing 플래그.
  private emitScheduled = false;
  // 종료(stop) 후 플래그. abort 로 인한 뒤늦은 emit/save 가 삭제된 세션을
  // 되살리는 것을 막는다 (삭제 후 부활 방지).
  private stopped = false;

  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private abort = new AbortController();
  private run: Query | null = null;
  // SDK query 루프가 떴는지. 지연 복원 세션은 false 로 시작해 첫 사용 때 start() 된다.
  private started = false;
  // 부팅 직렬화 상태.
  // bootStarted: 첫 프롬프트로 부팅을 이미 시작했는지(이후 입력은 게이트 없이 바로 큐로).
  // preBootBuffer: 부팅 락을 기다리는 동안 들어온 입력들(순서 보존용, 락이 풀리면 flush).
  // releaseBoot: 내 부팅 락의 resolver. init/종료/백스톱 중 먼저 온 신호가 호출해 다음 세션을 푼다.
  private bootStarted = false;
  private preBootBuffer: SDKUserMessage[] = [];
  private releaseBoot: (() => void) | null = null;
  // 자동 컴팩션 임계값을 한 번만 적용하기 위한 가드 (init 은 컴팩션마다 다시 옴).
  private compactionApplied = false;
  // 일시적 스트림 오류 재시도 상태. consumeRetries 는 '연속 실패' 횟수(성공 응답 오면 0).
  private consumeRetries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // 응답 지연 계측(진단용). 턴 시작 시각과 첫 토큰 도착 여부로 TTFT/총시간을 잰다.
  private turnStartMs: number | null = null;
  private firstTokenSeen = false;
  private ttftMs = 0;
  // 도구 실행에 쓴 시간(tool_use → tool_result 구간의 합). 턴 전체에서 모델 시간과
  // 이 값을 빼면 남는 게 '순수 오버헤드'(직렬화·파이프 백프레셔 등)라 원인을 가를 수 있다.
  private toolSpanMs = 0;
  private toolStartMs: number | null = null;
  private toolCount = 0;
  // 폰에 보여줄 컨텍스트 사용량. SDK 기동 전에는 알 수 없어 null.
  private contextUsage: ContextUsage | null = null;
  // SDK 의 duration_api_ms 는 '이번 턴'이 아니라 세션 시작부터의 누적값이다.
  // 턴별 모델 시간을 얻으려면 직전 값과의 차이를 써야 한다.
  private lastDurApiMs = -1; // -1 = 아직 기준값 없음(세션 첫 result)

  constructor(opts: SessionOpts) {
    this.id = opts.id;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.root = opts.root ?? null;
    this.ownerId = opts.ownerId ?? null;
    this.onUpdate = opts.onUpdate;
    // 복원 케이스: 이전 sdkSessionId/기록/시각을 이어받는다. 없으면 새 세션.
    this.sdkSessionId = opts.resumeSessionId ?? null;
    this.messages = opts.initialMessages ? [...opts.initialMessages] : [];
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.updatedAt = opts.updatedAt ?? this.createdAt;
    // 지연 복원 세션은 SDK 가 아직 없으니 '시작중'이 아니라 '대기'로 보여준다.
    if (opts.lazy) this.status = 'idle';
  }

  /**
   * SDK query 루프를 시작한다 (지연 복원 세션은 첫 사용 때 호출됨). 중복 호출은 무시.
   * query() 는 즉시 만든다 — 입력이 없으면 서브프로세스를 띄우지 않으므로(따라서
   * ~/.claude.json 도 안 건드리므로) 여러 개를 동시에 만들어도 안전하다.
   * 실제 부팅(=쓰기 경쟁 지점)은 첫 프롬프트가 enqueue() → 부팅 게이트를 지나 입력 큐에
   * 들어갈 때 비로소 시작되고, 그 게이트가 '한 번에 하나씩'을 보장한다.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.stopped) return; // 이미 종료됐으면 띄우지 않는다
    this.spawnQuery();
  }

  /**
   * SDK query() 를 (재)생성하고 소비 루프를 건다. 최초 start() 와, 일시적 스트림 오류
   * (ECONNRESET/컴팩션 끊김 등) 후 resume 재시도(scheduleRetry)에서 공용으로 쓴다.
   */
  private spawnQuery(): void {
    this.run = query({
      prompt: this.inputQueue,
      options: {
        cwd: this.cwd,
        abortController: this.abort,
        // 복원 케이스: 이전 SDK 세션을 이어받는다(~/.claude/projects/ 의 transcript 로드).
        // 없으면 undefined → 새 세션으로 시작. resume 는 streaming-input 모드와 함께 동작한다.
        ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
        // 전역 ~/.claude/settings.json 의 allow 규칙을 상속하지 않는다.
        // 'project'만 로드 → 프로젝트 CLAUDE.md 는 살리되, 모든 도구 승인은
        // canUseTool(=폰)로 강제된다. (전역 allowlist 가 게이트를 우회하는 것 방지)
        settingSources: ['project'],
        permissionMode: 'default',
        // Claude Code 기본 시스템 프롬프트 + 공통 헌법(SYSTEM_APPEND) 주입.
        // 위험 모드면 헌법에 "도구 자동 실행" 경고가 덧붙는다.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(this.root) },
        // 로컬 스킬 플러그인 주입 + 전부 활성화. settingSources 와 무관하게 로드되므로
        // 전역 allowlist 는 끌어오지 않는다 → 폰 승인 게이트(canUseTool) 그대로 유지.
        // 스킬이 부르는 도구도 여전히 canUseTool 을 거쳐 폰 승인을 받는다.
        plugins: [{ type: 'local', path: SKILLS_PLUGIN_DIR }],
        skills: 'all',
        // SDK 서브프로세스의 stderr/디버그 로그를 파일로 캡처한다.
        // stall 이 다시 나면 'SDK 쪽 관점'에서 진단할 유일한 창구. (현재는 버려지고 있었음)
        stderr: (data: string) => this.logStderr(data),
        debug: process.env.SDK_DEBUG === '1',
        // 도구 실행 직전 가로채기 → 폰으로 Yes/No 라우팅
        canUseTool: async (toolName, input, { signal, title }) => {
          // AskUserQuestion: Yes/No 가 아니라 "선택지"를 폰에 띄우고 답을 모아
          // updatedInput.answers 로 돌려준다. (SDK 가 의도한 권한-컴포넌트 경로)
          if (toolName === 'AskUserQuestion') {
            const questions = extractQuestions(input);
            if (questions.length === 0) {
              return { behavior: 'allow', updatedInput: input };
            }
            const qid = shortId('q');
            this.question = { requestId: qid, questions, at: new Date().toISOString() };
            this.addItem('tool', `질문: ${questions.map((q) => q.header || q.question).join(' / ')}`);
            this.setStatus('awaiting_question');
            const answers = await registerQuestion(qid, this.id, signal);
            this.question = null;
            this.setStatus('thinking');
            // answers 가 null(중단/건너뜀)이면 빈 객체 → 도구는 "답 없음"으로 진행
            return {
              behavior: 'allow',
              updatedInput: { ...(input as Record<string, unknown>), answers: answers ?? {} },
            };
          }

          // 폴더 샌드박스: 계정 루트 밖 파일을 건드리는 도구는 위험/안전 모드와 무관하게 차단.
          // (root=null 무제한 계정이면 통과.) 위험 모드 자동 허용보다 먼저 검사해야 뚫리지 않는다.
          const offending = offendingToolPath(toolName, input, this.root);
          if (offending) {
            this.addItem('system', `차단됨(루트 밖): ${toolName} → ${offending}`);
            this.setStatus('thinking');
            return {
              behavior: 'deny',
              message: `이 세션은 '${this.root}' 폴더 밖의 경로에 접근할 수 없습니다: ${offending}`,
            };
          }

          // 위험 모드: 방향 결정(AskUserQuestion)을 제외한 모든 도구는 묻지 않고 자동 허용.
          // 어떤 도구가 돌았는지는 assistant 의 tool_use 블록으로 폰 스트림에 그대로 남는다.
          // isDanger() 를 매 호출마다 읽으므로, 폰 스위치 토글이 진행 중 세션에도 즉시 반영된다.
          if (isDanger()) {
            return { behavior: 'allow', updatedInput: input };
          }

          const requestId = shortId('perm');
          this.pending = {
            requestId,
            toolName,
            title,
            summary: summarizeToolInput(toolName, input),
            input,
            at: new Date().toISOString(),
          };
          this.setStatus('awaiting_permission');
          const decision = await registerPermission(requestId, this.id, signal);
          this.pending = null;
          if (decision === 'yes') {
            this.setStatus('thinking');
            return { behavior: 'allow', updatedInput: input };
          }
          this.addItem('system', `거부됨: ${toolName}`);
          this.setStatus('thinking');
          return { behavior: 'deny', message: '사용자가 거부함' };
        },
      },
    });

    void this.consume();
  }

  /**
   * 세션에 입력을 넣는다. 첫 입력은 서브프로세스를 부팅(=.claude.json 쓰기)시키므로 전역
   * bootChain 에 줄을 세워 '한 번에 하나씩' 부팅한다. 부팅 이후 입력은 게이트 없이 바로 큐로.
   * 락 대기 중 들어온 입력은 preBootBuffer 에 순서대로 모았다가 락이 풀리면 함께 흘려보낸다.
   */
  private enqueue(msg: SDKUserMessage): void {
    if (this.bootStarted) {
      // 이미 부팅 시작(락 획득)됨 → 순서 보존하며 바로 입력 큐로.
      this.inputQueue.push(msg);
      return;
    }
    // 아직 부팅 전: 버퍼에 모은다. 첫 진입에서만 부팅 게이트를 건다(락은 세션당 한 번).
    this.preBootBuffer.push(msg);
    if (this.preBootBuffer.length > 1) return;
    const prev = bootChain;
    bootChain = new Promise<void>((release) => {
      this.releaseBoot = release;
    });
    // 앞 세션이 init(또는 백스톱)으로 자리를 비운 뒤에 내 첫 입력을 흘려보낸다.
    prev.then(() => this.flushBoot()).catch(() => this.flushBoot());
  }

  /** 부팅 락을 잡은 순간: 모아둔 첫 입력들을 순서대로 큐로 밀어 부팅을 시작하고 백스톱을 건다. */
  private flushBoot(): void {
    if (this.stopped) {
      this.settleBoot(); // 대기 중 종료됐으면 부팅하지 않고 즉시 다음 세션을 푼다
      return;
    }
    this.bootStarted = true;
    for (const m of this.preBootBuffer) this.inputQueue.push(m); // 여기서 서브프로세스 부팅 시작
    this.preBootBuffer = [];
    // init(=쓰기 완료)이 오면 settleBoot() 로 다음 세션을 푼다. 안 오면 이 백스톱이 푼다.
    setTimeout(() => this.settleBoot(), BOOT_SETTLE_MS);
  }

  /** 부팅 게이트를 한 번만 풀어준다 (init / 백스톱 / 종료·오류 중 가장 먼저 온 신호). */
  private settleBoot(): void {
    const release = this.releaseBoot;
    if (release) {
      this.releaseBoot = null;
      release();
    }
  }

  /** SDK 출력 스트림을 소비하며 상태/메시지를 갱신 */
  private async consume(): Promise<void> {
    try {
      for await (const msg of this.run!) {
        if (process.env.DEBUG_BLOCKS) this.debugDump(msg);
        this.handleMessage(msg);
      }
    } catch (err) {
      // 부팅 직후 죽었더라도 게이트를 풀어 다음 세션 부팅이 막히지 않게 한다.
      this.settleBoot();
      // 의도적 종료(stop→abort)로 인한 throw 는 에러로 표시하지 않는다.
      // (에러 상태로 두면 touch→emit 이 삭제된 세션을 다시 저장/브로드캐스트한다)
      if (this.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      this.logError(err); // 원인은 재시도 성공/실패와 무관하게 항상 남긴다
      // 일시적 네트워크/컴팩션 오류: 세션을 'error' 로 죽이지 않고 resume 으로 자동 재시도.
      // resume 은 sdkSessionId 가 있어야 컨텍스트를 이어받으므로, 없으면 재시도 의미가 없다.
      if (
        this.sdkSessionId &&
        this.consumeRetries < STREAM_MAX_RETRIES &&
        isRetryableStreamError(message)
      ) {
        this.scheduleRetry(message);
        return;
      }
      // 재시도 불가(복원 id 없음/일시적 오류 아님)·재시도 소진 → 진짜 오류로 표시.
      this.error = message;
      this.addItem('error', this.error);
      this.setStatus('error');
    }
  }

  /**
   * 일시적 스트림 오류 후 지수 백오프로 resume 재접속을 예약한다.
   * - 크래시한 이터레이터가 입력 큐에 남긴 대기 resolver 가 다음 입력을 삼키지 않도록
   *   입력 큐를 새로 만든다(백오프 중 들어오는 입력은 새 큐에 쌓여 재접속 후 소비됨).
   * - 새 run 에는 컴팩션 설정을 다시 걸어야 하므로 가드를 풀어 init 에서 재적용되게 한다.
   */
  private scheduleRetry(message: string): void {
    this.consumeRetries += 1;
    const delay = STREAM_RETRY_BASE_MS * 2 ** (this.consumeRetries - 1); // 2s → 4s → 8s …
    this.addItem(
      'system',
      `⚠ 연결 오류 — ${Math.round(delay / 1000)}s 후 재시도 ${this.consumeRetries}/${STREAM_MAX_RETRIES}: ${message}`,
    );
    this.setStatus('starting'); // 재연결 중임을 폰에 표시
    this.compactionApplied = false; // 새 run 에서 컴팩션 설정 재적용
    this.inputQueue = new AsyncQueue<SDKUserMessage>(); // 죽은 이터레이터의 대기 resolver 폐기
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.spawnQuery(); // resume(sdkSessionId) 로 다시 붙는다
    }, delay);
    // 재시도 타이머가 프로세스 종료를 붙잡지 않게 한다.
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  private handleMessage(msg: SDKMessage): void {
    this.markActivity(); // SDK 가 살아있다는 신호 → stall 시계 리셋
    this.consumeRetries = 0; // SDK 가 다시 응답 → '연속 실패' 카운터 리셋
    switch (msg.type) {
      case 'system': {
        const sm = msg as Record<string, unknown>;
        if (sm.subtype === 'init') {
          this.sdkSessionId = msg.session_id;
          if (this.status === 'starting') this.setStatus('idle');
          // 설정 파일(~/.claude.json) 쓰기가 끝난 시점 → 부팅 게이트를 풀어 다음 세션을 부팅시킨다.
          this.settleBoot();
          // 컨트롤 채널이 열린 직후(init) 자동 컴팩션 임계값을 낮춘다.
          // 복원된 큰 세션은 다음 턴에서 이 임계값을 넘어 곧바로 압축된다.
          // init 은 컴팩션 직후에도 다시 오므로, 한 번만 적용되게 가드.
          if (!this.compactionApplied) {
            this.compactionApplied = true;
            void this.applyCompactionSettings();
          }
        } else if (sm.subtype === 'compact_boundary') {
          // 자동 컴팩션 경로(autoCompactWindow)에서 오는 신호. pre/post 토큰으로 표시.
          const meta = sm.compact_metadata as { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined;
          const pre = meta?.pre_tokens != null ? Math.round(meta.pre_tokens / 1000) + 'k' : '?';
          const post = meta?.post_tokens != null ? Math.round(meta.post_tokens / 1000) + 'k' : '?';
          const how = meta?.trigger === 'manual' ? '수동' : '자동';
          this.addItem('system', `🗜 컨텍스트 압축됨(${how}): ${pre} → ${post}`);
        } else if (sm.subtype === 'status') {
          // 수동 /compact 경로 신호: 'compacting' 시작 → compact_result(success|failed).
          if (sm.status === 'compacting') {
            this.addItem('system', '🗜 컨텍스트 압축 중…');
          } else if (sm.compact_result === 'success') {
            this.addItem('system', '🗜 컨텍스트 압축 완료');
          } else if (sm.compact_result === 'failed') {
            this.addItem('system', `🗜 압축 건너뜀: ${String(sm.compact_error ?? '알 수 없음')}`);
          }
        }
        break;
      }

      case 'assistant': {
        // 첫 토큰 도착(TTFT) — 프롬프트→첫 응답까지 몇 초 걸렸는지. 느림의 핵심 지표.
        if (!this.firstTokenSeen && this.turnStartMs != null) {
          this.firstTokenSeen = true;
          this.ttftMs = Date.now() - this.turnStartMs;
        }
        const blocks = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        let sawTool = false;
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            this.addItem('text', block.text);
          } else if (block.type === 'tool_use') {
            this.addItem('tool', summarizeToolInput(String(block.name), block.input));
            sawTool = true;
            this.toolCount += 1;
          }
        }
        // 도구 호출이 나왔다 → 여기서부터 tool_result 가 돌아올 때까지가 '도구 대기' 구간
        if (sawTool && this.toolStartMs == null) this.toolStartMs = Date.now();
        this.setStatus('thinking');
        break;
      }

      case 'result': {
        // 성공 시 result 는 마지막 assistant 텍스트와 동일 → 중복이라 로그에 안 남긴다.
        // 비정상 종료(에러/턴 한도 등)만 종료 사유로 표시한다.
        if (msg.subtype !== 'success') {
          this.addItem('result', `(${msg.subtype})`);
        }
        this.recordPerf(msg as Record<string, unknown>); // 응답 지연 실측 기록
        this.setStatus('idle'); // 턴 완료 → 다음 입력 대기
        break;
      }

      case 'user': {
        // tool_result 가 돌아온 시점 → 도구 대기 구간 종료. (사용자 입력 replay 도 여기로 오지만
        // toolStartMs 가 null 이면 그냥 지나간다.)
        if (this.toolStartMs != null) {
          this.toolSpanMs += Date.now() - this.toolStartMs;
          this.toolStartMs = null;
        }
        break;
      }

      default:
        break; // stream_event(부분) 등은 무시
    }
  }

  /** DEBUG_BLOCKS 일 때만: SDK 메시지의 타입/블록을 콘솔에 덤프 (서버측 도구 추적) */
  private debugDump(msg: SDKMessage): void {
    const m = msg as Record<string, any>;
    if (m.type === 'assistant') {
      const blocks = (m.message?.content ?? []) as Array<Record<string, any>>;
      for (const b of blocks) {
        const extra = b.name ? ` name=${b.name}` : b.type === 'text' ? ` "${String(b.text).slice(0, 80)}"` : '';
        console.log(`[blocks] assistant block: ${b.type}${extra}`);
      }
    } else if (m.type === 'user') {
      const blocks = (m.message?.content ?? []) as Array<Record<string, any>>;
      const types = Array.isArray(blocks) ? blocks.map((b) => b.type).join(',') : typeof blocks;
      console.log(`[blocks] user message (tool_result?): ${types}`);
    } else if (m.type === 'result') {
      console.log(`[blocks] result subtype=${m.subtype} usage=${JSON.stringify(m.usage?.server_tool_use ?? {})}`);
    } else {
      console.log(`[blocks] ${m.type}${m.subtype ? '/' + m.subtype : ''}`);
    }
  }

  /** 지연 복원 세션을 처음 쓸 때 SDK 를 띄운다. 이미 떠 있으면 무시. */
  ensureStarted(): void {
    if (!this.started) this.start();
  }

  /** 폰이 보낸 새 명령을 세션에 주입 (텍스트 + 선택적 이미지) */
  sendPrompt(text: string, images: InputImage[] = []): void {
    if (this.status === 'error') return;
    // 지연 복원 세션이면 이 시점에 SDK 를 띄운다(resume). 큐는 시작 전 push 도 버퍼링한다.
    this.ensureStarted();
    const suffix = images.length ? ` [🖼 이미지 ${images.length}장]` : '';
    this.addItem('user', (text || '(이미지)') + suffix);

    // 이미지가 있으면 content 를 블록 배열로, 없으면 기존처럼 문자열로
    const content = images.length
      ? [
          ...(text ? [{ type: 'text', text }] : []),
          ...images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          })),
        ]
      : text;

    this.enqueue({
      type: 'user',
      // SDK 는 Anthropic content block 배열을 그대로 받는다 (타입만 우회)
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null,
    });
    this.lastActivityAt = Date.now(); // SDK 응답을 기다리기 시작 → stall 시계 시작
    this.turnStartMs = this.lastActivityAt; // 지연 계측 시작
    this.firstTokenSeen = false;
    this.toolSpanMs = 0;
    this.toolStartMs = null;
    this.toolCount = 0;
    this.stalled = false;
    this.setStatus('thinking');
  }

  /** 자동 컴팩션 임계값을 낮춰 컨텍스트 폭주를 막는다. 실패해도 세션은 계속(최적화일 뿐). */
  private async applyCompactionSettings(): Promise<void> {
    try {
      // Settings 키(autoCompactEnabled/autoCompactWindow)를 런타임 설정 레이어에 병합.
      if (!this.run) {
        this.logError(`[compaction] run 이 없어 설정을 못 걸었다 (window=${COMPACT_WINDOW})`);
        return;
      }
      await this.run.applyFlagSettings({
        autoCompactEnabled: true,
        autoCompactWindow: COMPACT_WINDOW,
      } as Record<string, unknown>);
      // 실측 결과 컴팩션이 한 번도 안 걸린 적이 있다(마커 0건). 성공도 남겨야
      // '적용은 됐는데 안 걸리는지' vs '적용 자체가 실패하는지'를 가릴 수 있다.
      this.logError(`[compaction] 적용됨 window=${COMPACT_WINDOW}`);
      // 적용됐다고 해서 CLI 가 그 값을 임계값으로 쓴다는 보장은 없다.
      // SDK 에 직접 물어 '실제 임계값/활성화 여부'를 확인한다.
      void this.logContextUsage('apply');
    } catch (err) {
      // 삼키면 컴팩션이 안 걸려도 영영 모른다 — 세션은 살리되 기록은 남긴다.
      this.logError(`[compaction] 적용 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * SDK 에 현재 컨텍스트 사용량과 '실제' 자동 컴팩션 임계값을 물어 로그에 남긴다.
   * applyFlagSettings 가 성공해도 CLI 가 그 값을 임계값으로 쓰는지는 별개라, 이 값이
   * 우리가 건 window 와 다르면 설정이 트리거 경로까지 닿지 않았다는 뜻이다.
   */
  private async logContextUsage(tag: string): Promise<void> {
    try {
      const u = await this.run?.getContextUsage();
      if (!u) return;
      // 폰 표시용으로 보관 → view() 에 실려 WS 로 나간다.
      this.contextUsage = {
        total: u.totalTokens ?? 0,
        max: u.maxTokens ?? 0,
        pct: Math.round(u.percentage ?? 0),
        compactAt: u.autoCompactThreshold ?? null,
      };
      this.scheduleEmit();
      const k = (n: number | undefined) => (n == null ? '-' : Math.round(n / 1000) + 'k');
      this.logError(
        `[context/${tag}] total=${k(u.totalTokens)} max=${k(u.maxTokens)} ` +
          `rawMax=${k(u.rawMaxTokens)} pct=${Math.round(u.percentage ?? 0)}% ` +
          `autoCompactThreshold=${k(u.autoCompactThreshold)} enabled=${u.isAutoCompactEnabled}`,
      );
    } catch (err) {
      this.logError(`[context/${tag}] 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 폰의 CPT 버튼 → 지금 즉시 수동 컴팩션. /compact 를 입력 스트림에 넣어 압축을 건다. */
  compact(): void {
    if (this.status === 'error') return;
    this.ensureStarted(); // 지연 복원 세션이면 먼저 SDK 기동
    this.addItem('user', '/compact (컨텍스트 압축 요청)');
    this.enqueue({
      type: 'user',
      message: { role: 'user', content: '/compact' as never },
      parent_tool_use_id: null,
    });
    this.lastActivityAt = Date.now();
    this.stalled = false;
    this.setStatus('thinking');
  }

  /** 진행 중인 턴을 중단 */
  async interrupt(): Promise<void> {
    try {
      await this.run?.interrupt();
    } catch {
      /* 스트리밍 입력 모드가 아니거나 이미 끝남 */
    }
  }

  /** 세션을 완전히 종료하고 자원 정리 */
  stop(): void {
    this.stopped = true; // 이후 어떤 emit/save 도 막는다 → 삭제 후 부활 방지
    this.settleBoot(); // 부팅 게이트에서 대기 중이었다면 풀어 다음 세션 부팅을 막지 않는다
    if (this.retryTimer) {
      clearTimeout(this.retryTimer); // 예약된 재접속이 있으면 취소
      this.retryTimer = null;
    }
    rejectSessionPermissions(this.id);
    this.inputQueue.close();
    this.abort.abort();
  }

  // --- 상태 헬퍼 ---

  private addItem(kind: StreamItem['kind'], text: string): void {
    this.messages.push({ id: shortId('m'), kind, text, at: new Date().toISOString() });
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.touch();
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.touch();
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
    this.scheduleEmit();
  }

  // 핵심 수정: broadcast(=view 전체 직렬화 + WS 전송)를 read loop 의 동기 경로에서 빼낸다.
  // 예전엔 SDK 메시지 하나마다 동기로 JSON.stringify(전체) → 전송을 하느라 파이프를
  // 늦게 비웠고, 큰 tool_result(긴 파일)가 OS 파이프 버퍼를 채우면 서브프로세스가
  // write 에서 막혀 stall 됐다. setImmediate 로 미뤄 한 tick 의 변경들을 1번으로 합치고,
  // 루프는 즉시 다음 메시지를 읽어 파이프를 비운다.
  private scheduleEmit(): void {
    if (this.stopped) return; // 종료된 세션은 더 이상 emit/save 하지 않는다
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setImmediate(() => {
      this.emitScheduled = false;
      // stop() 직전 이미 예약돼 있던 emit 이 종료 후 터지는 경우도 막는다.
      if (this.stopped) return;
      this.onUpdate(this.view());
    });
  }

  /** SDK 가 살아있다는 신호. stall 시계를 리셋하고, 정체 표시였다면 즉시 해제. */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.stalled) {
      this.stalled = false;
      this.touch();
    }
  }

  /** SDK 가 응답 중이어야 할 상태인데 너무 오래 조용한가? (중단이 아니라 표시용) */
  private isStalled(): boolean {
    if (this.status !== 'thinking' && this.status !== 'starting') return false;
    return Date.now() - this.lastActivityAt > STALL_HINT_MS;
  }

  /** SessionManager 의 주기 sweeper 가 호출. 정체 상태가 바뀌었으면 폰에 알린다. */
  checkStall(): void {
    const now = this.isStalled();
    if (now !== this.stalled) {
      this.stalled = now;
      this.touch();
    }
  }

  /**
   * SDK 스트림 루프에서 던져진 오류를 logs/errors.log 에 영구 기록한다.
   * 폰이 보는 "CLI 응답 에러"의 실제 원인(과부하/네트워크/서브프로세스 크래시)을
   * 사후에 확인하기 위한 관찰용. 세션별 로그(logs/<id>.log)에도 함께 남긴다.
   */
  private logError(err: unknown): void {
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      const at = new Date().toISOString();
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
      const line = `[${at}] ${this.id} "${this.title}" (${this.cwd})\n  ${msg}${stack}\n`;
      appendFileSync(ERROR_LOG, line);
      appendFileSync(join(LOG_DIR, `${this.id}.log`), line);
    } catch {
      /* 로깅 실패가 세션을 죽이면 안 된다 */
    }
  }

  /**
   * 응답 지연 실측. result 메시지의 SDK 자체 타이밍(duration_ms=전체, duration_api_ms=모델 API)과
   * usage(입력·캐시읽기·출력 토큰)를 뽑아 logs/perf.log 에 남기고, SCREEN_PERF=1 이면 폰에도 한 줄.
   * 이걸로 "느림이 모델 처리(api_ms)인지, 컨텍스트가 큰지, 캐시가 안 먹는지"를 숫자로 가른다.
   */
  private recordPerf(rm: Record<string, unknown>): void {
    try {
      const wall = this.turnStartMs != null ? Date.now() - this.turnStartMs : 0;
      this.turnStartMs = null;
      const durTotal = Number(rm.duration_ms) || 0;
      const durApiCum = Number(rm.duration_api_ms) || 0;
      // 누적값 → 턴별 값으로 환산. 재개(resume) 등으로 값이 되감기면 그대로 쓴다.
      // 세션 첫 result 는 기준값이 없어 델타를 만들 수 없다 → 모델 시간 '미상'으로 두고 기준만 세운다.
      const apiKnown = this.lastDurApiMs >= 0;
      const durApi = !apiKnown ? 0 : durApiCum >= this.lastDurApiMs ? durApiCum - this.lastDurApiMs : durApiCum;
      this.lastDurApiMs = durApiCum;
      // turnStartMs 가 없던 턴(도구 연쇄·복원 직후 등)은 SDK 의 duration_ms 를 기준으로 삼는다.
      const base = wall > 0 ? wall : durTotal;
      const u = (rm.usage ?? {}) as Record<string, number>;
      const input = Number(u.input_tokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens) || 0;
      const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
      const output = Number(u.output_tokens) || 0;
      const ctx = input + cacheRead + cacheWrite; // 이번 턴이 실제로 읽은 컨텍스트 크기
      const s = (n: number) => (n / 1000).toFixed(1) + 's';
      const k = (n: number) => Math.round(n / 1000) + 'k';
      const cacheHitPct = ctx ? Math.round((cacheRead / ctx) * 100) : 0;
      // 아직 안 닫힌 도구 구간이 있으면(결과 없이 턴이 끝난 경우) 여기서 마감한다.
      if (this.toolStartMs != null) {
        this.toolSpanMs += Date.now() - this.toolStartMs;
        this.toolStartMs = null;
      }
      // 모델도 도구도 아닌 시간 = 순수 오버헤드(직렬화·브로드캐스트·파이프 백프레셔 등).
      // 이 값이 크면 우리 코드 문제, 작으면 지연은 모델/도구의 정당한 소요다.
      const overhead = Math.max(0, base - durApi - this.toolSpanMs);
      const modelTxt = apiKnown ? s(durApi) : '-';
      const overTxt = apiKnown ? s(overhead) : '-';
      // 이번 턴에 첫 토큰을 못 본 경우 ttftMs 는 이전 턴 값이라 신뢰할 수 없다 → '-' 로 표기.
      const ttft = this.firstTokenSeen ? s(this.ttftMs) : '-';
      // 캐시 히트율이 낮으면 매 턴 큰 컨텍스트를 새로 읽는 것 → 느림·고비용의 직접 원인.
      const line =
        `⏱ ${s(base)} (첫토큰 ${ttft} · 모델 ${modelTxt} · ` +
        `도구 ${s(this.toolSpanMs)}×${this.toolCount} · 그외 ${overTxt}) · ` +
        `컨텍스트 ${k(ctx)}(캐시 ${cacheHitPct}%) · 출력 ${k(output)}`;
      try {
        if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
        appendFileSync(
          PERF_LOG,
          `[${new Date().toISOString()}] ${this.id} "${this.title}" ${line} ` +
            `[raw wall=${wall} base=${base} ttft=${this.firstTokenSeen ? this.ttftMs : -1} ` +
            `total=${durTotal} api=${durApi} apiCum=${durApiCum} ` +
            `tools=${this.toolSpanMs}/${this.toolCount} overhead=${overhead} ` +
            `in=${input} cacheR=${cacheRead} cacheW=${cacheWrite} out=${output}]\n`,
        );
      } catch { /* 로깅 실패가 세션을 죽이면 안 된다 */ }
      if (PERF_SHOW) this.addItem('system', line);
      // 턴마다 실제 컨텍스트가 임계값을 넘고도 압축이 안 걸리는지 추적한다.
      void this.logContextUsage('turn');
    } catch { /* 계측 실패가 세션을 죽이면 안 된다 */ }
  }

  /** SDK 서브프로세스 stderr/디버그 출력을 세션별 파일에 적재. 실패는 무시. */
  private logStderr(data: string): void {
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(join(LOG_DIR, `${this.id}.log`), data);
    } catch {
      /* 로깅 실패가 세션을 죽이면 안 된다 */
    }
  }

  /** 직렬화 가능한 스냅샷 */
  view(): SessionView {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      root: this.root,
      ownerId: this.ownerId,
      status: this.status,
      sdkSessionId: this.sdkSessionId,
      messages: this.messages,
      pending: this.pending,
      question: this.question,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      error: this.error,
      stalled: this.isStalled(),
      context: this.contextUsage,
    };
  }
}

// resume 재접속으로 회복 가능한(대개 일시적인) 스트림 오류인가?
// 컴팩션 중 ECONNRESET/과부하/게이트웨이 오류 등 네트워크성 실패만 재시도 대상이다.
// 논리 오류(잘못된 입력·인증 실패 등)는 재시도해도 같은 결과라 걸러낸다.
function isRetryableStreamError(message: string): boolean {
  const m = message.toLowerCase();
  return [
    'econnreset',
    'etimedout',
    'econnrefused',
    'socket hang up',
    'unable to connect',
    'during compaction',
    'fetch failed',
    'network',
    'overloaded',
    '502',
    '503',
    '504',
    '529',
  ].some((needle) => m.includes(needle));
}

/** AskUserQuestion 입력에서 폰이 그릴 문항 목록을 뽑아낸다 */
function extractQuestions(input: unknown): QuestionSpec[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q): QuestionSpec => {
    const obj = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(obj.options)
      ? obj.options.map((o) => {
          const oo = (o ?? {}) as Record<string, unknown>;
          return {
            label: String(oo.label ?? ''),
            description: String(oo.description ?? ''),
          };
        })
      : [];
    return {
      question: String(obj.question ?? ''),
      header: String(obj.header ?? ''),
      multiSelect: obj.multiSelect === true,
      options,
    };
  });
}

/** 도구 입력을 사람이 읽을 한 줄 요약으로 */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') return `${toolName}: ${obj.command}`;
    if (typeof obj.file_path === 'string') return `${toolName}: ${obj.file_path}`;
    if (typeof obj.path === 'string') return `${toolName}: ${obj.path}`;
    if (typeof obj.pattern === 'string') return `${toolName}: ${obj.pattern}`;
  }
  const json = JSON.stringify(input ?? {});
  return `${toolName}: ${json.length > 200 ? json.slice(0, 200) + '…' : json}`;
}
