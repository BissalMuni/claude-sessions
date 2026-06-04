import { resolve as resolvePath } from 'node:path';
import { Session } from './session.js';
import { shortId } from './ids.js';
import { resolvePermission, resolveQuestion, type Answers, type Decision } from './permissions.js';
import type { ServerEvent, SessionView } from './types.js';

/** 세션 풀을 관리하고 변경을 구독자(WebSocket)에게 알린다 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private subscribers = new Set<(event: ServerEvent) => void>();

  /** WebSocket 허브가 구독. 해제 함수 반환 */
  subscribe(fn: (event: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private broadcast(event: ServerEvent): void {
    for (const fn of this.subscribers) fn(event);
  }

  /** 새 세션 생성 + 시작 */
  create(opts: { cwd: string; title?: string }): SessionView {
    const id = shortId('sess');
    const cwd = resolvePath(opts.cwd);
    const session = new Session({
      id,
      cwd,
      title: opts.title?.trim() || cwd.split(/[\\/]/).pop() || cwd,
      onUpdate: (view) => this.broadcast({ type: 'session_update', session: view }),
    });
    this.sessions.set(id, session);
    session.start();
    return session.view();
  }

  /** 명령 주입 */
  sendPrompt(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.sendPrompt(text);
    return true;
  }

  /** 승인/거부 (폰 → canUseTool 대기 해소) */
  approve(requestId: string, decision: Decision): boolean {
    return resolvePermission(requestId, decision);
  }

  /** AskUserQuestion 선택 응답 (폰 → canUseTool 대기 해소) */
  answer(requestId: string, answers: Answers): boolean {
    return resolveQuestion(requestId, answers);
  }

  /** 진행 중인 턴 중단 */
  async interrupt(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.interrupt();
    return true;
  }

  /** 세션 종료 + 제거 */
  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.stop();
    this.sessions.delete(id);
    this.broadcast({ type: 'session_removed', sessionId: id });
    return true;
  }

  get(id: string): SessionView | null {
    return this.sessions.get(id)?.view() ?? null;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view());
  }

  /** 프로세스 종료 시 전체 정리 */
  shutdown(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
