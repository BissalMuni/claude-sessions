import { resolve as resolvePath } from 'node:path';
import { isDanger, setDanger } from './dangerMode.js';
import { Session } from './session.js';
import { shortId } from './ids.js';
import { bumpFolderFreq } from './folderFreq.js';
import { resolvePermission, resolveQuestion, type Answers, type Decision } from './permissions.js';
import { flushSessions, loadPersistedSessions, markEnded, saveSession } from './sessionStore.js';
import { sessionVisibleTo, type Account } from './auth.js';
import type { AuxStatus, InputImage, ServerEvent, SessionView } from './types.js';

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
    let restored = 0;
    for (const rec of records) {
      if (rec.ended) continue; // 종료(보관)된 세션은 기록만 남기고 활성으로 복원하지 않는다
      if (this.sessions.has(rec.id)) continue;
      const session = new Session({
        id: rec.id,
        cwd: rec.cwd,
        root: rec.root ?? null, // 복원 세션도 원래 샌드박스 루트를 유지
        ownerId: rec.ownerId ?? null, // 소유 계정도 유지(격리 지속)
        title: rec.title,
        onUpdate: this.onSessionUpdate,
        resumeSessionId: rec.sdkSessionId,
        initialMessages: rec.messages,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        lazy: true, // 첫 사용 시점까지 SDK 기동을 미룬다
      });
      this.sessions.set(rec.id, session);
      restored++;
      // start() 하지 않는다 — sendPrompt 시 Session 이 알아서 ensureStarted().
    }
    return restored;
  }

  /** 새 세션 생성 + 시작 */
  create(opts: { cwd: string; title?: string; root?: string | null; ownerId?: string | null }): SessionView {
    const id = shortId('sess');
    const cwd = resolvePath(opts.cwd);
    const session = new Session({
      id,
      cwd,
      root: opts.root ?? null, // 계정 샌드박스 루트(null=무제한)
      ownerId: opts.ownerId ?? null, // 생성한 계정 = 소유주(격리 기준)
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

  /**
   * 세션 종료(보관). SDK 를 정지하고 활성 목록에서 내리되, 기록은 스토어에 남긴다(ended 표시).
   * 재기동 시 restore() 가 ended 레코드를 건너뛰므로 종료한 세션은 되살아나지 않는다.
   * (완전 삭제가 아니라 '연속성 대상에서 제외' — 기록/감사는 보존.)
   */
  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    // 활성 맵에서 먼저 내린다 → onSessionUpdate 가드가 뒤늦은 저장을 막아 ended 표시를 덮어쓰지 않음.
    this.sessions.delete(id);
    session.stop();
    markEnded(id); // 삭제가 아니라 종료(보관): 기록은 남기고 복원만 차단
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

  /** 보조 서버(정적/업로드) 상태를 모든 구독자에게 브로드캐스트. */
  broadcastAux(aux: AuxStatus): void {
    this.broadcast({ type: 'aux', aux });
  }

  get(id: string): SessionView | null {
    return this.sessions.get(id)?.view() ?? null;
  }

  /** 이 계정이 그 세션을 볼/조작할 수 있는가(격리 검사). 없는 세션이면 false. */
  canAccess(id: string, account?: Account): boolean {
    const v = this.sessions.get(id)?.view();
    return !!v && sessionVisibleTo(v.ownerId, account);
  }

  /** 계정이 볼 수 있는 세션만 반환(소유 세션 + 레거시/공유). */
  getFor(id: string, account?: Account): SessionView | null {
    const v = this.get(id);
    return v && sessionVisibleTo(v.ownerId, account) ? v : null;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view());
  }

  /** 계정이 볼 수 있는 세션 목록(격리). */
  listFor(account?: Account): SessionView[] {
    return this.list().filter((v) => sessionVisibleTo(v.ownerId, account));
  }

  /**
   * 목록 표시용 세션들 = 현재 활성 세션 전부.
   * 종료(보관)된 세션은 restore() 가 애초에 활성으로 복원하지 않으므로 목록에 안 뜬다.
   * 따라서 예전처럼 폴더당 1개로 접을 필요가 없다 — 진행 중 세션은 폴더 무관 전부 보여준다.
   */
  listVisible(): SessionView[] {
    return this.list();
  }

  /** 프로세스 종료 시 전체 정리 */
  shutdown(): void {
    clearInterval(this.stallSweeper);
    flushSessions(); // 디바운스 중이던 변경을 디스크에 즉시 기록
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
