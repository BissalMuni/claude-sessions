import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './asyncQueue.js';
import { shortId } from './ids.js';
import { registerPermission, rejectSessionPermissions } from './permissions.js';
import type { PendingPermission, SessionStatus, SessionView, StreamItem } from './types.js';

const MAX_MESSAGES = 300; // 폰 메모리 보호: 최근 N개만 유지

export interface SessionOpts {
  id: string;
  title: string;
  cwd: string;
  /** 상태가 바뀔 때마다 호출 (WebSocket broadcast 연결용) */
  onUpdate: (view: SessionView) => void;
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
  private error: string | null = null;
  private readonly createdAt = new Date().toISOString();
  private updatedAt = this.createdAt;

  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private abort = new AbortController();
  private run: Query | null = null;

  constructor(opts: SessionOpts) {
    this.id = opts.id;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.onUpdate = opts.onUpdate;
  }

  /** SDK query 루프를 시작한다 */
  start(): void {
    this.run = query({
      prompt: this.inputQueue,
      options: {
        cwd: this.cwd,
        abortController: this.abort,
        // 전역 ~/.claude/settings.json 의 allow 규칙을 상속하지 않는다.
        // 'project'만 로드 → 프로젝트 CLAUDE.md 는 살리되, 모든 도구 승인은
        // canUseTool(=폰)로 강제된다. (전역 allowlist 가 게이트를 우회하는 것 방지)
        settingSources: ['project'],
        permissionMode: 'default',
        // 도구 실행 직전 가로채기 → 폰으로 Yes/No 라우팅
        canUseTool: async (toolName, input, { signal, title }) => {
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
        this.handleMessage(msg);
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.addItem('error', this.error);
      this.setStatus('error');
    }
  }

  private handleMessage(msg: SDKMessage): void {
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
        const text = msg.subtype === 'success' ? msg.result : `(${msg.subtype})`;
        this.addItem('result', text || '(완료)');
        this.setStatus('idle'); // 턴 완료 → 다음 입력 대기
        break;
      }

      default:
        break; // stream_event(부분)·user replay 등은 무시
    }
  }

  /** 폰이 보낸 새 명령을 세션에 주입 */
  sendPrompt(text: string): void {
    if (this.status === 'error') return;
    this.addItem('user', text);
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
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
    this.onUpdate(this.view());
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
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      error: this.error,
    };
  }
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
