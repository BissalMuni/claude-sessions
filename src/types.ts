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

/** 폰에서 첨부한 이미지 1장 (base64) — 메시지에 인라인으로 들어감 */
export interface InputImage {
  mediaType: string; // 예: 'image/png', 'image/jpeg'
  data: string; // base64 (data: 접두사 제외)
}

/** 폰에서 첨부한 임의 파일 1개 (base64) — 디스크에 저장 후 경로를 Claude 에 전달 */
export interface InputFile {
  name: string; // 원본 파일명 (서버에서 안전하게 정제됨)
  data: string; // base64
  mediaType?: string; // 있으면 참고용 (없어도 됨)
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
  /** 이 세션이 접근 가능한 루트 폴더(계정 샌드박스). null 이면 무제한. 도구 경로 검사 기준. */
  root: string | null;
  /** 세션 소유 계정 id(=토큰 해시). null 이면 레거시/공유(모든 계정에 보임). */
  ownerId: string | null;
  status: SessionStatus;
  sdkSessionId: string | null; // SDK가 발급한 실제 세션 id (resume용)
  messages: StreamItem[];
  pending: PendingPermission | null;
  question: PendingQuestion | null; // AskUserQuestion 선택 대기
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** SDK 가 응답 중이어야 하는데 오래 조용함 → '정체?' 표시 (중단이 아니라 신호) */
  stalled: boolean;
}

/** 보조 서버(정적/업로드) 상태 — 한 개 */
export interface AuxOne {
  running: boolean;
  dir?: string;
  port?: number;
}
/** 보조 서버 전체 상태 */
export interface AuxStatus {
  static: AuxOne;
  upload: AuxOne;
}

/** WebSocket 으로 서버 → 폰 푸시되는 이벤트 */
export type ServerEvent =
  | { type: 'snapshot'; sessions: SessionView[]; danger: boolean; aux: AuxStatus } // 접속 직후 전체(+위험 모드+보조 서버)
  | { type: 'session_update'; session: SessionView } // 세션 변경
  | { type: 'session_removed'; sessionId: string }
  | { type: 'danger'; danger: boolean } // 위험 모드 토글 (모든 기기 동기화)
  | { type: 'aux'; aux: AuxStatus }; // 보조 서버 상태 변경 (모든 기기 동기화)
