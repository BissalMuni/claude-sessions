import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import express from 'express';
import { createApiRouter } from './api.js';
import { createLiteRouter } from './lite.js';
import { attachWebSocket } from './ws.js';
import { SessionManager } from './sessionManager.js';
import { isDanger } from './dangerMode.js';
import { TOKEN } from './auth.js';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0'; // LAN 의 다른 기기에서 접속 가능하게
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 서버 본체 사망 방지/추적 가드 ──────────────────────────────────────────
// SDK 서브프로세스 stderr 는 logs/<id>.log 에 남지만, Node 서버 '본체'가 던지는
// uncaughtException/unhandledRejection 은 아무 데도 안 남았다. 그래서 .bat 창이
// "Server stopped" 만 찍고 닫히면 원인을 영영 못 봤다. 여기서 ① 잡아서 살리고
// ② logs/server.log 에 남긴다. Node 24 는 미처리 거부(unhandledRejection)가
// 기본적으로 프로세스를 죽이므로(--unhandled-rejections=throw), 이 핸들러가 없으면
// 비동기 에러 하나에 서버 전체가 조용히 종료된다.
const SERVER_LOG = join(__dirname, '..', 'logs', 'server.log');
function logServer(kind: string, detail: unknown): void {
  const body =
    detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
  const line = `[${new Date().toISOString()}] ${kind}: ${body}\n`;
  try {
    mkdirSync(join(__dirname, '..', 'logs'), { recursive: true });
    appendFileSync(SERVER_LOG, line);
  } catch {
    /* 로깅 실패가 더 큰 문제를 만들면 안 된다 */
  }
  console.error(line.trimEnd());
}
// 포트 충돌(EADDRINUSE)은 '이미 다른 서버 인스턴스가 8787 을 물고 있다'는 뜻 —
// 이중 실행이다. 이 중복 인스턴스는 어정쩡하게 살려두면 안 되고(리슨 못 하는 좀비),
// 명확한 안내와 함께 '재시작 금지' 코드(88)로 즉시 종료한다. .bat 루프가 이 코드를
// 보고 재시작하지 않는다(정상 인스턴스와 무한 충돌하는 것 방지).
const EXIT_PORT_BUSY = 88;
function handleBindError(err: unknown): boolean {
  if ((err as { code?: string })?.code !== 'EADDRINUSE') return false;
  logServer('EADDRINUSE', `포트 ${PORT} 이미 사용 중 — 다른 서버 인스턴스가 이미 실행 중. 이 창은 종료(중복 실행).`);
  console.error(`\n⚠ 포트 ${PORT} 을 이미 다른 서버가 쓰고 있습니다(이중 실행). 이 창을 닫으세요. 서버는 다른 창에서 정상 동작 중입니다.`);
  process.exit(EXIT_PORT_BUSY);
}
process.on('uncaughtException', (err) => {
  if (handleBindError(err)) return; // EADDRINUSE 는 위에서 종료 처리
  logServer('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => logServer('unhandledRejection', reason));
// '조용한 종료' 추적용: 이벤트 루프가 비어 정상 종료되려 할 때 / 실제 종료 코드.
// 서버 소켓이 살아있으면 beforeExit 는 안 떠야 정상 — 뜨면 그게 곧 단서다.
process.on('beforeExit', (code) => logServer('beforeExit', `event loop drained, code=${code}`));
process.on('exit', (code) => logServer('exit', `code=${code}`));
// ───────────────────────────────────────────────────────────────────────────

const manager = new SessionManager();
// 재기동: 디스크에 저장된 세션들을 SDK resume 으로 되살린다.
const restoredCount = manager.restore();
const app = express();
app.use(express.json({ limit: '50mb' })); // base64 이미지/파일 첨부 수용
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // lite UI 폼 파싱

// 구닥다리 e-ink 브라우저용 lite UI (JS 없는 서버 렌더링)
app.use('/lite', createLiteRouter(manager));

// 최신 기기용 SPA (정적). 토큰은 UI 안에서 입력받아 API/WS 호출에 붙인다.
// html/js/css 는 항상 재검증(no-cache): 폰·e-ink 브라우저가 옛 app.js 를 캐시해
// 새 UI 기능(예: 마크다운 표 렌더)이 반영 안 되던 문제 예방. ETag 로 미변경 시 304.
app.use(
  '/',
  express.static(join(__dirname, '..', 'web'), {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use('/api', createApiRouter(manager));

const server = createServer(app);
// listen 실패(EADDRINUSE 등)는 server 의 'error' 이벤트로 온다. 핸들러가 없으면
// 그 에러가 그대로 throw 되어 서버가 죽는다. EADDRINUSE 면 중복 실행이니 깔끔히 종료,
// 그 외는 로그만 남긴다.
server.on('error', (err) => {
  if (handleBindError(err)) return;
  logServer('server', err);
});
attachWebSocket(server, manager);

server.listen(PORT, HOST, () => {
  const ips = lanIps();
  console.log('─'.repeat(56));
  console.log(' claude-sessions 서버 시작');
  console.log(` 토큰: ${TOKEN}`);
  console.log(' 폰 브라우저 접속:');
  for (const ip of ips) console.log(`   http://${ip}:${PORT}`);
  console.log(`   (로컬: http://localhost:${PORT})`);
  if (restoredCount) console.log(` 복원된 세션: ${restoredCount}개 (SDK resume)`);
  // 부팅을 server.log 에도 남긴다 → 다음에 죽으면 '새 코드로 떴는지/언제 떴는지'가 확실해진다.
  logServer('boot', `pid=${process.pid} port=${PORT} restored=${restoredCount} node=${process.version}`);
  if (isDanger()) {
    console.log(' ⚠ 위험 모드 ON (기본값): 모든 도구 자동 실행, AskUserQuestion 만 폰 질문. 폰 스위치 또는 SCREEN_DANGER=0 으로 끌 수 있음');
  } else {
    console.log(' 안전 모드 (SCREEN_DANGER=0): 모든 도구가 폰 Yes/No 승인을 거침. 폰 스위치로 켤 수 있음');
  }
  console.log('─'.repeat(56));
});

// 깔끔한 종료 + '왜 멈췄는지' 기록. 창 닫기(Windows 는 SIGHUP/SIGBREAK), Ctrl+C(SIGINT),
// kill(SIGTERM) 을 모두 잡아 로그에 남긴다. 이래야 server.log 가 비어있지 않고
// "외부에서 종료됨(=크래시 아님)"인지 "내부 에러로 죽음"인지 다음엔 바로 구분된다.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logServer('signal', `${sig} 수신 → 정상 종료 (크래시 아님, 외부 종료)`);
    manager.shutdown();
    // 소켓이 늦게 닫혀도 창이 영영 안 닫히지 않게 안전 타임아웃 후 강제 종료.
    const t = setTimeout(() => process.exit(0), 2000);
    if (typeof t.unref === 'function') t.unref();
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
