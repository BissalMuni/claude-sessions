// 승인 대기 레지스트리.
// canUseTool 콜백이 register() 로 대기를 만들고, 폰 응답이 오면 resolve() 로 깨운다.

export type Decision = 'yes' | 'no';

/** AskUserQuestion 응답: 질문 문장 → 선택 라벨(복수 선택은 콤마 결합) */
export type Answers = Record<string, string>;

interface Waiter {
  resolve: (d: Decision) => void;
  sessionId: string;
}

interface AnswerWaiter {
  resolve: (a: Answers | null) => void; // null = 중단/건너뜀
  sessionId: string;
}

const waiters = new Map<string, Waiter>();
const answerWaiters = new Map<string, AnswerWaiter>();

/** 승인 1건을 등록하고, 폰 응답(혹은 abort)까지 기다리는 Promise 를 돌려준다 */
export function registerPermission(
  requestId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    waiters.set(requestId, { resolve, sessionId });

    // 세션이 중단되면 거부로 처리
    const onAbort = () => {
      if (waiters.delete(requestId)) resolve('no');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 폰에서 온 결정으로 대기를 해소한다. 해당 요청이 없으면 false */
export function resolvePermission(requestId: string, decision: Decision): boolean {
  const waiter = waiters.get(requestId);
  if (!waiter) return false;
  waiters.delete(requestId);
  waiter.resolve(decision);
  return true;
}

/** AskUserQuestion 1건을 등록하고, 폰 응답(혹은 abort)까지 기다린다 */
export function registerQuestion(
  requestId: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<Answers | null> {
  return new Promise<Answers | null>((resolve) => {
    answerWaiters.set(requestId, { resolve, sessionId });

    const onAbort = () => {
      if (answerWaiters.delete(requestId)) resolve(null);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 폰에서 온 선택으로 질문 대기를 해소한다. 해당 요청이 없으면 false */
export function resolveQuestion(requestId: string, answers: Answers): boolean {
  const waiter = answerWaiters.get(requestId);
  if (!waiter) return false;
  answerWaiters.delete(requestId);
  waiter.resolve(answers);
  return true;
}

/** 세션 종료 시 그 세션의 미해결 승인/질문을 모두 정리 */
export function rejectSessionPermissions(sessionId: string): void {
  for (const [requestId, waiter] of waiters) {
    if (waiter.sessionId === sessionId) {
      waiters.delete(requestId);
      waiter.resolve('no');
    }
  }
  for (const [requestId, waiter] of answerWaiters) {
    if (waiter.sessionId === sessionId) {
      answerWaiters.delete(requestId);
      waiter.resolve(null);
    }
  }
}
