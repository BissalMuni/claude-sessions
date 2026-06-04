// 서버 ↔ 폰 클라이언트가 공유하는 도메인 타입

/** 세션의 현재 단계 (상태 머신) */
export type SessionStatus =
  | 'starting' // 프로세스 기동 중
  | 'idle' // 입력 대기 (사용자 턴)
  | 'thinking' // Claude 작업/응답 생성 중
  | 'awaiting_permission' // 도구 실행 직전, Yes/No 대기
  | 'awaiting_question' // AskUserQuestion 선택 대기
  | 'done' // 턴 완료
  | 'error'; // 예외 발생

/** 폰에 보여줄 한 줄(스트림 아이템) */
export interface StreamItem {
  id: string;
  /** text=assistant 텍스트, tool=도구 호출, result=턴 결과, system=시스템, user=주입한 명령, error */
  kind: 'text' | 'tool' | 'result' | 'system' | 'user' | 'error';
  text: string;
  at: string; // ISO 시각
}

/** 승인 대기 1건 */
export interface PendingPermission {
  requestId: string; // 승인 식별자
  toolName: string; // 예: "Bash"
  title?: string; // SDK가 만든 프롬프트 문장
  summary: string; // 사람이 읽을 요약 (명령 텍스트 등)
  input: unknown; // 원본 도구 입력
  at: string;
}

/** AskUserQuestion 한 문항 (폰이 그릴 선택지) */
export interface QuestionSpec {
  question: string; // 질문 문장
  header: string; // 짧은 라벨(칩)
  multiSelect: boolean; // 복수 선택 허용 여부
  options: { label: string; description: string }[];
}

/** 선택 대기 1건 (AskUserQuestion) */
export interface PendingQuestion {
  requestId: string;
  questions: QuestionSpec[];
  at: string;
}

/** 폰에 보내는 세션 스냅샷 (직렬화 가능) */
export interface SessionView {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  sdkSessionId: string | null; // SDK가 발급한 실제 세션 id (resume용)
  messages: StreamItem[];
  pending: PendingPermission | null;
  question: PendingQuestion | null; // AskUserQuestion 선택 대기
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

/** WebSocket 으로 서버 → 폰 푸시되는 이벤트 */
export type ServerEvent =
  | { type: 'snapshot'; sessions: SessionView[] } // 접속 직후 전체
  | { type: 'session_update'; session: SessionView } // 세션 변경
  | { type: 'session_removed'; sessionId: string };
