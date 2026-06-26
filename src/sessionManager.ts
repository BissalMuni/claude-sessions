import { resolve as resolvePath } from 'node:path';
import { isDanger, setDanger } from './dangerMode.js';
import { Session } from './session.js';
import { shortId } from './ids.js';
import { bumpFolderFreq } from './folderFreq.js';
import { resolvePermission, resolveQuestion, type Answers, type Decision } from './permissions.js';
import { deleteSession, flushSessions, loadPersistedSessions, saveSession } from './sessionStore.js';
import type { InputImage, ServerEvent, SessionView } from './types.js';

/** 세션 풀을 관리하고 변경을 구독자(WebSocket)에게 알린다 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private subscribers = new Set<(event: ServerEvent) => void>();
  // 정체(stall) 감지 sweeper: 주기적으로 각 세션의 정체 여부를 재평가해 표시만 갱신한다.
  // SDK 무응답이면 새 메시지가 안 오므로, 이 타이머가 없으면 '정체?'가 영영 안 켜진다.
  private stallSweeper = setInterval(() => {
    for (const session of this.sessions.values()) session.checkStall();
  }, 10_000);

  /** WebSocket 허브가 구독. 해제 함수 반환 */
  subscribe(fn: (event: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private broadcast(event: ServerEvent): void {
    for (const fn of this.subscribers) fn(event);
  }

  // 세션 변경 1건: 폰에 broadcast + 디스크에 영속(디바운스). 모든 세션이 공유.
  private readonly onSessionUpdate = (view: SessionView): void => {
    // 이미 제거된 세션의 뒤늦은 업데이트는 무시한다(삭제 후 부활 방지의 2차 방어선).
    // 살아있는 세션은 항상 맵에 있으므로 정상 업데이트는 통과한다.
    if (!this.sessions.has(view.id)) return;
    this.broadcast({ type: 'session_update', session: view });
    saveSession(view);
  };

  /**
   * 서버 부팅 시 저장된 세션들을 복원한다. 단, SDK 서브프로세스는 즉시 띄우지 않는다(지연 복원).
   * 기록만 '대기' 상태로 올려두고, 사용자가 그 세션에 프롬프트를 보낼 때 resume 한다.
   * (24개를 동시에 띄우면 .claude.json 충돌·메모리 고갈로 전부 '오류'가 되던 문제 방지.)
   * 복원 개수 반환.
   */
  restore(): number {
    const records = loadPersistedSessions();
    for (const rec of records) {
      if (this.sessions.has(rec.id)) continue;
      const session = new Session({
        id: rec.id,
        cwd: rec.cwd,
        title: rec.title,
        onUpdate: this.onSessionUpdate,
        resumeSessionId: rec.sdkSessionId,
        initialMessages: rec.messages,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        lazy: true, // 첫 사용 시점까지 SDK 기동을 미룬다
      });
      this.sessions.set(rec.id, session);
      // start() 하지 않는다 — sendPrompt 시 Session 이 알아서 ensureStarted().
    }
    return records.length;
  }

  /** 새 세션 생성 + 시작 */
  create(opts: { cwd: string; title?: string }): SessionView {
    const id = shortId('sess');
    const cwd = resolvePath(opts.cwd);
    const session = new Session({
      id,
      cwd,
      title: opts.title?.trim() || cwd.split(/[\\/]/).pop() || cwd,
      onUpdate: this.onSessionUpdate,
    });
    this.sessions.set(id, session);
    // 폴더 사용 빈도 +1 (서버에 영속 저장 → 피커 정렬용, 모든 기기 공유).
    // 피커가 /browse 의 폴더 문자열로 조회하므로 같은 원본 cwd 로 카운트한다.
    bumpFolderFreq(opts.cwd);
    // 생성 즉시 모든 구독자(폰)에게 알린다 + 디스크에 영속. 이게 없으면 새 세션은
    // SDK init 이벤트가 늦게 도착하거나 새로고침(snapshot) 전까지 보이지 않는다.
    this.onSessionUpdate(session.view());
    session.start();
    return session.view();
  }

  /** 명령 주입 (텍스트 + 선택적 이미지) */
  sendPrompt(id: string, text: string, images: InputImage[] = []): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.sendPrompt(text, images);
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

  /** 수동 컴팩션 (폰 CPT 버튼) — 해당 세션 컨텍스트를 지금 압축 */
  compact(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.compact();
    return true;
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
    deleteSession(id); // 저장소에서도 제거 → 재기동 시 복원 안 됨
    this.broadcast({ type: 'session_removed', sessionId: id });
    return true;
  }

  /** 현재 위험 모드 여부 */
  isDanger(): boolean {
    return isDanger();
  }

  /** 위험 모드 토글 + 모든 구독자(폰)에게 동기화 브로드캐스트. 바뀐 값 반환. */
  setDanger(on: boolean): boolean {
    const v = setDanger(on);
    this.broadcast({ type: 'danger', danger: v });
    return v;
  }

  get(id: string): SessionView | null {
    return this.sessions.get(id)?.view() ?? null;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view());
  }

  /**
   * 목록 표시용 세션들. 같은 폴더(cwd)는 가장 최근(updatedAt) 세션 하나만 남긴다.
   * 나머지 지난(종료된) 중복 세션은 기록(store)은 보존하되 목록에서만 숨긴다.
   * 화면 표시 전용 필터이므로 list()/저장소는 그대로 두고 여기서만 거른다.
   */
  listVisible(): SessionView[] {
    const latest = new Map<string, SessionView>();
    for (const v of this.list()) {
      const cur = latest.get(v.cwd);
      if (!cur || v.updatedAt.localeCompare(cur.updatedAt) > 0) latest.set(v.cwd, v);
    }
    return [...latest.values()];
  }

  /** 프로세스 종료 시 전체 정리 */
  shutdown(): void {
    clearInterval(this.stallSweeper);
    flushSessions(); // 디바운스 중이던 변경을 디스크에 즉시 기록
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
