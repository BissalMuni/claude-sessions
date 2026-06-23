import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncQueue } from './asyncQueue.js';
import { isDanger } from './dangerMode.js';
import { shortId } from './ids.js';
import { registerPermission, registerQuestion, rejectSessionPermissions } from './permissions.js';
import type {
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
  '너는 사용자가 폰으로 원격 감시하는 자율 세션이다. 다음을 항상 지켜라:',
  '- 프로젝트 방향에 영향을 주는 결정에 부딪히면 임의로 진행하지 말고 `AskUserQuestion` 으로 사용자에게 물어라.',
  '  해당: 아키텍처/기술 선택, 요구사항이 모호하거나 해석이 갈릴 때,',
  '  비가역적·위험한 작업(데이터/파일 삭제, force push, 배포, 시스템 설정 변경, 재부팅),',
  '  작업 범위가 크게 늘어나는 변경.',
  '- 그 외 일상적인 읽기·탐색·빌드·편집은 멈추지 말고 진행하라.',
  '- 질문할 때는 선택지를 구체적으로 제시하고 첫 번째에 권장안을 둬라.',
].join('\n');

// 위험 모드일 때만 덧붙이는 경고. 도구가 자동 실행되므로 질문이 유일한 안전장치임을 명시.
const DANGER_NOTE = [
  '',
  '## 위험 모드 안내',
  '현재 모든 도구는 사용자 승인 없이 자동 실행된다.',
  '따라서 위 "방향 결정 시 질문" 규칙이 사용자가 개입할 수 있는 유일한 안전장치다.',
  '특히 비가역적·위험한 작업을 실행하기 전에는 반드시 먼저 `AskUserQuestion` 으로 확인하라.',
].join('\n');

// 세션 시작 시점의 위험 모드에 맞춰 시스템 프롬프트 append 를 만든다.
// (이미 떠 있는 세션의 systemPrompt 는 바꿀 수 없으므로, 토글 이후 새로 만든
//  세션부터 경고가 반영된다. 게이트 동작 자체는 isDanger() 로 즉시 반영됨.)
function buildSystemAppend(): string {
  return isDanger() ? `${CONSTITUTION}\n${DANGER_NOTE}` : CONSTITUTION;
}

// 이 시간(ms)보다 오래 SDK 가 무응답이면 '정체?'로 표시한다. 끊지 않는다 — 보여주기만.
const STALL_HINT_MS = Number(process.env.STALL_HINT_MS) || 90_000;
// SDK 서브프로세스 stderr/디버그 로그를 세션별로 남길 디렉터리
const LOG_DIR = join(process.cwd(), 'logs');

// 로컬 스킬 플러그인(절대경로). src/ 든 dist/ 든 항상 설치 루트의 skills-plugin/ 을
// 가리킨다. 세션 cwd 와 무관하게 모든 세션에 같은 스킬 묶음을 주입하기 위함.
// (skills-plugin/skills 는 ~/.claude/skills 로의 junction)
const SKILLS_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills-plugin');

export interface SessionOpts {
  id: string;
  title: string;
  cwd: string;
  /** 상태가 바뀔 때마다 호출 (WebSocket broadcast 연결용) */
  onUpdate: (view: SessionView) => void;
  /** 복원용: 재기동 시 이어받을 SDK 세션 id (있으면 query 에 resume 로 전달) */
  resumeSessionId?: string | null;
  /** 복원용: 폰에 다시 보여줄 이전 대화 기록 */
  initialMessages?: StreamItem[];
  /** 복원용: 원래 생성/갱신 시각 (없으면 now) */
  createdAt?: string;
  updatedAt?: string;
}

/** 하나의 Claude Agent SDK 세션 = 작업 한 줄기 */
export class Session {
  readonly id: string;
  private title: string;
  private cwd: string;
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

  constructor(opts: SessionOpts) {
    this.id = opts.id;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.onUpdate = opts.onUpdate;
    // 복원 케이스: 이전 sdkSessionId/기록/시각을 이어받는다. 없으면 새 세션.
    this.sdkSessionId = opts.resumeSessionId ?? null;
    this.messages = opts.initialMessages ? [...opts.initialMessages] : [];
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.updatedAt = opts.updatedAt ?? this.createdAt;
  }

  /** SDK query 루프를 시작한다 */
  start(): void {
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
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend() },
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

  /** SDK 출력 스트림을 소비하며 상태/메시지를 갱신 */
  private async consume(): Promise<void> {
    try {
      for await (const msg of this.run!) {
        if (process.env.DEBUG_BLOCKS) this.debugDump(msg);
        this.handleMessage(msg);
      }
    } catch (err) {
      // 의도적 종료(stop→abort)로 인한 throw 는 에러로 표시하지 않는다.
      // (에러 상태로 두면 touch→emit 이 삭제된 세션을 다시 저장/브로드캐스트한다)
      if (this.stopped) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.addItem('error', this.error);
      this.setStatus('error');
    }
  }

  private handleMessage(msg: SDKMessage): void {
    this.markActivity(); // SDK 가 살아있다는 신호 → stall 시계 리셋
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sdkSessionId = msg.session_id;
          if (this.status === 'starting') this.setStatus('idle');
        }
        break;

      case 'assistant': {
        const blocks = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            this.addItem('text', block.text);
          } else if (block.type === 'tool_use') {
            this.addItem('tool', summarizeToolInput(String(block.name), block.input));
          }
        }
        this.setStatus('thinking');
        break;
      }

      case 'result': {
        // 성공 시 result 는 마지막 assistant 텍스트와 동일 → 중복이라 로그에 안 남긴다.
        // 비정상 종료(에러/턴 한도 등)만 종료 사유로 표시한다.
        if (msg.subtype !== 'success') {
          this.addItem('result', `(${msg.subtype})`);
        }
        this.setStatus('idle'); // 턴 완료 → 다음 입력 대기
        break;
      }

      default:
        break; // stream_event(부분)·user replay 등은 무시
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

  /** 폰이 보낸 새 명령을 세션에 주입 (텍스트 + 선택적 이미지) */
  sendPrompt(text: string, images: InputImage[] = []): void {
    if (this.status === 'error') return;
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

    this.inputQueue.push({
      type: 'user',
      // SDK 는 Anthropic content block 배열을 그대로 받는다 (타입만 우회)
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null,
    });
    this.lastActivityAt = Date.now(); // SDK 응답을 기다리기 시작 → stall 시계 시작
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
      status: this.status,
      sdkSessionId: this.sdkSessionId,
      messages: this.messages,
      pending: this.pending,
      question: this.question,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      error: this.error,
      stalled: this.isStalled(),
    };
  }
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
