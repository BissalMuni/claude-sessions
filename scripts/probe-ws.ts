// 승인 후 WebSearch 결과가 WebSocket 으로 실제 푸시되는지 확인.
// 서버가 idle+답변 이벤트를 내려보내면 → 서버 푸시는 정상 → 폰이 못 보는 건 전송 계층 문제.
// 실행: pnpm tsx scripts/probe-ws.ts
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:8787';
const TOK = 'changeme';
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' };

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${encodeURIComponent(TOK)}`);
let sid: string | null = null;
let approved = false;

ws.on('open', () => log('WS open'));
ws.on('message', async (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.type === 'snapshot') {
    log('WS snapshot, sessions=', ev.sessions.length);
    // 세션 생성 + WebSearch 프롬프트
    const c = (await (await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ cwd: 'd:/Coding/claude-sessions', title: 'ws-probe' }) })).json()) as { session: { id: string } };
    sid = c.session.id;
    log('created', sid);
    await fetch(`${BASE}/api/sessions/${sid}/prompt`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'Use WebSearch to find what day 2026-06-06 is. One sentence + source.' }) });
    log('prompt sent');
  } else if (ev.type === 'session_update' && ev.session.id === sid) {
    const s = ev.session;
    const lastMsg = s.messages.at(-1);
    log(`WS update: status=${s.status}` + (lastMsg ? ` last=[${lastMsg.kind}] ${String(lastMsg.text).replace(/\s+/g, ' ').slice(0, 50)}` : ''));
    // 승인 대기가 오면 1회 승인
    if (s.status === 'awaiting_permission' && s.pending && !approved) {
      approved = true;
      log('>>> approving via WS-observed pending');
      await fetch(`${BASE}/api/sessions/${sid}/approve`, { method: 'POST', headers: H, body: JSON.stringify({ requestId: s.pending.requestId, decision: 'yes' }) });
    }
    if (s.status === 'idle' && approved) {
      log('=== reached idle AFTER approval — checking if answer arrived over WS ===');
      const hasAnswer = s.messages.some((m: { kind: string; text: string }) => m.kind === 'text' && /saturday|토요일/i.test(m.text));
      log('answer present in pushed update?', hasAnswer);
      await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE', headers: H });
      ws.close();
      process.exit(0);
    }
  }
});
ws.on('error', (e) => { log('WS error', e.message); process.exit(1); });
setTimeout(() => { log('TIMEOUT — no idle+answer over WS within 60s'); process.exit(2); }, 60_000);
