// 로컬 서버 현황 — 이 PC 에서 LISTEN 중인 TCP 포트를 훑어, 알려진 고정 서버(레지스트리)는
// 이름·설명을 붙이고, 나머지는 '기타'로 보여준다. 폰의 "🖥️ 서버 현황" 페이지가 이걸 읽는다.
//
// 판정 기준: netstat -ano 의 LISTENING 목록(로컬 리스너의 권위 있는 출처)에 그 포트가 있으면
// up. 별도 소켓 프로브는 하지 않는다(netstat 이 이미 정확하고, 타임아웃 지연도 없다).

import { execFile } from 'node:child_process';

/** 고정 서버 레지스트리 — coding 생태계 포트(claudia/docs/PORTS.md 와 맞춤). */
export interface ServerEntry {
  port: number;
  name: string;
  desc: string;
  project: string;
}
const REGISTRY: ServerEntry[] = [
  { port: 8787, name: '세션 컨트롤러', desc: '자율세션 원격 감시 (이 서버)', project: 'claude-sessions' },
  { port: 8788, name: '허브 백엔드', desc: 'API/WS · /health', project: 'claudia' },
  { port: 8789, name: '리포트 뷰어', desc: '일일 다이제스트 열람(폰)', project: 'claudia' },
  { port: 5174, name: '웹 대시보드(dev)', desc: 'Vite 대시보드', project: 'claudia' },
  { port: 9099, name: '캡처 갤러리', desc: 'img-server', project: 'claudia' },
  { port: 8790, name: '문서/노트 서버', desc: 'server.js', project: 'pdf-reader' },
  { port: 8791, name: '업로드 서버(보조)', desc: 'aux upload', project: 'claude-sessions' },
  { port: 8848, name: 'frontinus 백엔드', desc: 'python -m virgo.frontinus', project: 'virgo' },
  { port: 5173, name: '프런트 dev', desc: 'Vite', project: 'virgo' },
  { port: 7474, name: 'Neo4j (http)', desc: 'docker', project: 'sss' },
  { port: 7687, name: 'Neo4j (bolt)', desc: 'docker', project: 'sss' },
  { port: 7475, name: 'Neo4j staging (http)', desc: 'docker', project: 'sss' },
  { port: 7688, name: 'Neo4j staging (bolt)', desc: 'docker', project: 'sss' },
  { port: 5433, name: 'Postgres', desc: 'docker taxeval', project: 'sss' },
  { port: 1103, name: '정적 파일 서버', desc: 'server.py', project: 'jh' },
];

export interface KnownServer extends ServerEntry {
  up: boolean;
  pid: number | null;
}
export interface OtherServer {
  port: number;
  pid: number | null;
  name: string; // 프로세스 이미지명 (tasklist), 못 찾으면 ''
}
export interface ServerStatus {
  at: string;
  known: KnownServer[];
  others: OtherServer[];
  hidden: number; // '기타'에서 걸러낸 Windows 시스템/커널 포트 개수(숨김 표시용)
}

// '기타' 목록에서 제외할 Windows 시스템/커널 프로세스(이미지명, 소문자 비교).
// 폰에서 내 개발 서버만 보이게 — 135/139/445/RPC 같은 OS 잡음을 걷어낸다.
const SYSTEM_PROCS = new Set([
  'system', 'registry', 'memory compression', 'svchost.exe', 'lsass.exe',
  'services.exe', 'wininit.exe', 'winlogon.exe', 'csrss.exe', 'smss.exe',
  'spoolsv.exe', 'searchindexer.exe', 'dllhost.exe', 'msmpeng.exe',
  'fontdrvhost.exe', 'taskhostw.exe', 'wlanext.exe',
]);
const EPHEMERAL_MIN = 49152; // 동적/RPC 포트 대역 — 서버 리스너로 보지 않음

/** 기타 후보가 OS 잡음인가(시스템 프로세스 또는 동적/RPC 포트). */
function isSystemNoise(name: string, port: number): boolean {
  if (port >= EPHEMERAL_MIN) return true;
  return SYSTEM_PROCS.has(name.trim().toLowerCase());
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout || '');
    });
  });
}

/** netstat -ano → Map<port, pid>. LISTENING 만, 포트당 첫 pid(중복 IPv4/IPv6 은 접음). */
async function listeningPorts(): Promise<Map<number, number>> {
  const out = await run('netstat', ['-ano', '-p', 'TCP']);
  const map = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // 예:  TCP    0.0.0.0:8788    0.0.0.0:0    LISTENING    12345
    if (parts.length < 4 || parts[0] !== 'TCP') continue;
    if (parts[3] !== 'LISTENING') continue;
    const local = parts[1];
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port)) continue;
    const pid = Number(parts[4]);
    if (!map.has(port)) map.set(port, Number.isInteger(pid) ? pid : 0);
  }
  return map;
}

/** tasklist → Map<pid, 이미지명>. 필요한 pid 만 이름을 붙인다. */
async function processNames(pids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.size === 0) return map;
  const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
  for (const line of out.split(/\r?\n/)) {
    // "이미지명","PID","세션이름","세션#","메모리"
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (!m) continue;
    const pid = Number(m[2]);
    if (pids.has(pid)) map.set(pid, m[1]);
  }
  return map;
}

/** 서버 현황 스냅샷 — 알려진 고정 서버 + 기타 LISTEN 포트. */
export async function serverStatus(): Promise<ServerStatus> {
  const listen = await listeningPorts();
  const knownPorts = new Set(REGISTRY.map((e) => e.port));

  // 이름을 붙일 pid 모으기: 알려진 서버 중 켜진 것 + 기타 전부
  const pids = new Set<number>();
  for (const e of REGISTRY) {
    const pid = listen.get(e.port);
    if (pid) pids.add(pid);
  }
  for (const [port, pid] of listen) {
    if (!knownPorts.has(port) && pid) pids.add(pid);
  }
  const names = await processNames(pids);

  const known: KnownServer[] = REGISTRY.map((e) => {
    const pid = listen.get(e.port);
    return { ...e, up: listen.has(e.port), pid: pid ?? null };
  });

  const others: OtherServer[] = [];
  let hidden = 0;
  for (const [port, pid] of [...listen.entries()].sort((a, b) => a[0] - b[0])) {
    if (knownPorts.has(port)) continue;
    const name = (pid && names.get(pid)) || '';
    if (isSystemNoise(name, port)) { hidden++; continue; } // OS 잡음은 개수만 세고 숨김
    others.push({ port, pid: pid || null, name });
  }

  return { at: new Date().toISOString(), known, others, hidden };
}
