import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import express from 'express';
import { createApiRouter } from './api.js';
import { createLiteRouter } from './lite.js';
import { attachWebSocket } from './ws.js';
import { SessionManager } from './sessionManager.js';
import { TOKEN } from './auth.js';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0'; // LAN 의 다른 기기에서 접속 가능하게
const __dirname = dirname(fileURLToPath(import.meta.url));

const manager = new SessionManager();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // lite UI 폼 파싱

// 구닥다리 e-ink 브라우저용 lite UI (JS 없는 서버 렌더링)
app.use('/lite', createLiteRouter(manager));

// 최신 기기용 SPA (정적). 토큰은 UI 안에서 입력받아 API/WS 호출에 붙인다.
app.use('/', express.static(join(__dirname, '..', 'web')));

app.use('/api', createApiRouter(manager));

const server = createServer(app);
attachWebSocket(server, manager);

server.listen(PORT, HOST, () => {
  const ips = lanIps();
  console.log('─'.repeat(56));
  console.log(' claude-sessions 서버 시작');
  console.log(` 토큰: ${TOKEN}`);
  console.log(' 폰 브라우저 접속:');
  for (const ip of ips) console.log(`   http://${ip}:${PORT}`);
  console.log(`   (로컬: http://localhost:${PORT})`);
  console.log('─'.repeat(56));
});

// 깔끔한 종료
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    manager.shutdown();
    server.close(() => process.exit(0));
  });
}

/** LAN IPv4 주소들 */
function lanIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out.length ? out : ['localhost'];
}
