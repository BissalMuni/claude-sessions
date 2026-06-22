import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TOKEN } from './auth.js';
import type { SessionManager } from './sessionManager.js';

// WebSocket 허브: 인증된 폰들에게 세션 이벤트를 푸시한다.
// 접속 시 ?token= 으로 인증하고, 즉시 전체 스냅샷을 보낸다.
export function attachWebSocket(server: Server, manager: SessionManager): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // 하트비트: 반쯤 끊긴(half-open) 소켓 감지용. 구형 e-ink 브라우저나 불안정한
  // 링크는 close 이벤트 없이 조용히 죽어, 승인 후 결과 푸시가 유실된다.
  // 30초마다 ping → pong 안 오면 terminate → 클라이언트가 재연결하며 새 snapshot 수신.
  const alive = new WeakSet<WebSocket>();
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      ws.close(4001, 'unauthorized');
      return;
    }

    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    // 접속 직후 현재 전체 상태 전송 (+ 위험 모드 현재값)
    ws.send(JSON.stringify({ type: 'snapshot', sessions: manager.list(), danger: manager.isDanger() }));

    // 이후 변경을 구독
    const unsubscribe = manager.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });
}
