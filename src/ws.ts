import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TOKEN } from './auth.js';
import type { SessionManager } from './sessionManager.js';

// WebSocket 허브: 인증된 폰들에게 세션 이벤트를 푸시한다.
// 접속 시 ?token= 으로 인증하고, 즉시 전체 스냅샷을 보낸다.
export function attachWebSocket(server: Server, manager: SessionManager): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      ws.close(4001, 'unauthorized');
      return;
    }

    // 접속 직후 현재 전체 상태 전송
    ws.send(JSON.stringify({ type: 'snapshot', sessions: manager.list() }));

    // 이후 변경을 구독
    const unsubscribe = manager.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });
}
