import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { accountForToken, sessionVisibleTo } from './auth.js';
import { auxStatus } from './auxServers.js';
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
    // 다계정: 등록된 계정 중 하나와 토큰이 일치해야 통과(단일 TOKEN 비교 아님).
    const account = accountForToken(url.searchParams.get('token'));
    if (!account) {
      ws.close(4001, 'unauthorized');
      return;
    }

    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    // 접속 직후 현재 전체 상태 전송 (계정 격리: 볼 수 있는 세션만) (+ 위험 모드 + 보조 서버)
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: manager.listFor(account),
        danger: manager.isDanger(),
        aux: auxStatus(),
      }),
    );

    // 이후 변경을 구독. 격리: 이 계정이 못 보는 세션의 업데이트는 흘려보내지 않는다.
    // (session_removed 는 sessionId 만 있어 소유 판별 불가하지만, 클라가 모르는 id 삭제는 무해하므로 그대로 전달.)
    const unsubscribe = manager.subscribe((event) => {
      if (ws.readyState !== ws.OPEN) return;
      if (event.type === 'session_update' && !sessionVisibleTo(event.session.ownerId, account)) return;
      ws.send(JSON.stringify(event));
    });

    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });
}
