// 승인 대기 레지스트리.
// canUseTool 콜백이 register() 로 대기를 만들고, 폰 응답이 오면 resolve() 로 깨운다.

export type Decision = 'yes' | 'no';

interface Waiter {
  resolve: (d: Decision) => void;
  sessionId: string;
}

const waiters = new Map<string, Waiter>();

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

/** 세션 종료 시 그 세션의 미해결 승인들을 모두 거부 처리 */
export function rejectSessionPermissions(sessionId: string): void {
  for (const [requestId, waiter] of waiters) {
    if (waiter.sessionId === sessionId) {
      waiters.delete(requestId);
      waiter.resolve('no');
    }
  }
}
