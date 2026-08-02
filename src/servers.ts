// 로컬 서버 현황 — 이 PC 에서 LISTEN 중인 TCP 포트를 훑어, 알려진 고정 서버(레지스트리)는
// 이름·설명을 붙이고, 나머지는 '기타'로 보여준다. 폰의 "🖥️ 서버 현황" 페이지가 이걸 읽는다.
//
// 판정 기준: netstat -ano 의 LISTENING 목록(로컬 리스너의 권위 있는 출처)에 그 포트가 있으면
// up. 별도 소켓 프로브는 하지 않는다(netstat 이 이미 정확하고, 타임아웃 지연도 없다).

import { execFile } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

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
  { port: 8790, name: '문서/노트 서버', desc: 'server.js', project: 'readwrite' },
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

// tasklist 는 ~700ms 로 비싸다. 서버 현황(processNames)과 RAM 탭(memStatus)이
// 같은 5초 주기에 둘 다 호출하므로, 짧은 TTL 캐시로 스캔을 1회로 합친다.
let taskCache: { at: number; out: string } | null = null;
const TASKLIST_TTL_MS = 3000;
async function tasklistCsv(): Promise<string> {
  const now = Date.now();
  if (taskCache && now - taskCache.at < TASKLIST_TTL_MS) return taskCache.out;
  const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
  taskCache = { at: now, out };
  return out;
}

/** tasklist → Map<pid, 이미지명>. 필요한 pid 만 이름을 붙인다. */
async function processNames(pids: Set<number>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.size === 0) return map;
  const out = await tasklistCsv();
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

// ---------- RAM 사용현황 ----------
// "서버 현황" 밑에 붙는 RAM 탭이 읽는다. 시스템 전체 메모리 + 프로세스별 사용량(상위 N).
// 프로세스는 폰에서 골라 종료할 수 있으므로, 종료 가드(guardKill)로 이 서버 자신과
// OS 핵심 프로세스는 절대 못 죽이게 막는다.

export interface ProcInfo {
  pid: number;
  name: string;
  mb: number; // Working Set (물리 메모리) MB
  self: boolean; // 이 컨트롤러 서버 프로세스인가(종료 금지 표시)
  protectedProc: boolean; // OS 핵심/보호 대상이라 종료 불가인가
}
export interface MemStatus {
  at: string;
  totalMb: number;
  freeMb: number;
  usedMb: number;
  usedPct: number;
  procs: ProcInfo[];
}

// 종료를 막을 OS 핵심 프로세스(이미지명 소문자). 실수로 시스템을 깨는 걸 방지.
const PROTECTED_PROCS = new Set([
  'system', 'system idle process', 'registry', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe',
  'lsass.exe', 'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe',
  'spoolsv.exe', 'taskhostw.exe', 'ctfmon.exe',
]);
const PROTECTED_PIDS = new Set([0, 4]); // System Idle, System

/** tasklist 메모리 문자열("70,388 K") → MB(정수). 실패 시 0. */
function parseMemKb(s: string): number {
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return 0;
  return Math.round(Number(digits) / 1024); // KB → MB
}

/**
 * 프로세스별 RAM 사용량 상위 목록. tasklist 한 번으로 전 프로세스를 훑고 MB 로 환산해
 * 내림차순 정렬 후 상위 `top` 개만 돌려준다(폰 화면·페이로드 절약).
 */
export async function memStatus(top = 30): Promise<MemStatus> {
  const totalMb = Math.round(totalmem() / 1024 / 1024);
  const freeMb = Math.round(freemem() / 1024 / 1024);
  const usedMb = totalMb - freeMb;
  const usedPct = totalMb ? Math.round((usedMb / totalMb) * 100) : 0;

  const out = await tasklistCsv();
  const rows: ProcInfo[] = [];
  const self = process.pid;
  for (const line of out.split(/\r?\n/)) {
    // "이미지명","PID","세션이름","세션#","메모리 사용"
    const m = line.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/);
    if (!m) continue;
    const name = m[1];
    const pid = Number(m[2]);
    const mb = parseMemKb(m[3]);
    const lname = name.trim().toLowerCase();
    rows.push({
      pid,
      name,
      mb,
      self: pid === self,
      protectedProc: PROTECTED_PIDS.has(pid) || PROTECTED_PROCS.has(lname),
    });
  }
  rows.sort((a, b) => b.mb - a.mb);
  return { at: new Date().toISOString(), totalMb, freeMb, usedMb, usedPct, procs: rows.slice(0, top) };
}

// ---------- 앱별 프로세스 목록 ----------
// "서버 현황"에서 VS Code/Edge/Chrome 처럼 인스턴스가 여러 개로 흩어지는 GUI 앱을
// 이미지명으로 묶어 보여주고, 골라서(또는 그룹째) 종료할 수 있게 한다. RAM 탭은 상위 30개만
// 보여줘서 18개짜리 VS Code 전부를 볼 수 없기에, 이 목록은 대상 앱의 '모든' 인스턴스를 준다.

export interface AppProc { pid: number; mb: number; protectedProc: boolean; self: boolean }
export interface AppGroup { app: string; label: string; count: number; totalMb: number; procs: AppProc[] }
export interface AppProcStatus { at: string; groups: AppGroup[] }

// 묶어서 보여줄 대상 GUI 앱(이미지명 소문자 → 표시 라벨). node/claude 는 컨트롤러·세션이라
// 일부러 넣지 않는다(실수로 제어를 끊는 걸 막는다). 필요하면 여기만 늘리면 된다.
const APP_TARGETS: { image: string; label: string }[] = [
  { image: 'code.exe', label: 'VS Code' },
  { image: 'chrome.exe', label: 'Chrome' },
  { image: 'msedge.exe', label: 'Edge' },
];

/** 대상 앱들의 모든 인스턴스를 이미지명으로 묶어 반환(각 그룹은 메모리 내림차순). */
export async function appProcesses(): Promise<AppProcStatus> {
  const out = await tasklistCsv();
  const self = process.pid;
  const byImage = new Map<string, AppProc[]>();
  for (const line of out.split(/\r?\n/)) {
    // "이미지명","PID","세션이름","세션#","메모리 사용"
    const m = line.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/);
    if (!m) continue;
    const image = m[1].trim().toLowerCase();
    if (!APP_TARGETS.some((t) => t.image === image)) continue;
    const pid = Number(m[2]);
    const arr = byImage.get(image) ?? [];
    arr.push({
      pid,
      mb: parseMemKb(m[3]),
      self: pid === self, // 대상 앱엔 컨트롤러가 없지만, 방어적으로 표시(종료 UI 잠금)
      protectedProc: PROTECTED_PIDS.has(pid),
    });
    byImage.set(image, arr);
  }
  const groups: AppGroup[] = [];
  for (const t of APP_TARGETS) {
    const procs = (byImage.get(t.image) ?? []).sort((a, b) => b.mb - a.mb);
    if (!procs.length) continue;
    groups.push({
      app: t.image,
      label: t.label,
      count: procs.length,
      totalMb: procs.reduce((s, p) => s + p.mb, 0),
      procs,
    });
  }
  return { at: new Date().toISOString(), groups };
}

export interface KillResult { ok: boolean; pid: number; reason?: string }

/**
 * 프로세스 종료 — 반드시 특정 PID 만. 이 서버 자신(process.pid)과 OS 핵심 프로세스는
 * 절대 못 죽이게 막는다(이름으로 일괄 종료 금지 원칙과 동일). taskkill /F /PID 사용.
 */
export async function killProcess(pid: number): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, pid, reason: '잘못된 PID' };
  if (pid === process.pid) return { ok: false, pid, reason: '컨트롤러 서버 자신은 종료할 수 없습니다' };
  if (PROTECTED_PIDS.has(pid)) return { ok: false, pid, reason: 'OS 핵심 프로세스는 종료할 수 없습니다' };

  // 이름 확인 후 보호 대상이면 거부(가드 이중화).
  const names = await processNames(new Set([pid]));
  const lname = (names.get(pid) || '').trim().toLowerCase();
  if (lname && PROTECTED_PROCS.has(lname)) {
    return { ok: false, pid, reason: `보호된 프로세스(${lname})는 종료할 수 없습니다` };
  }

  return await new Promise<KillResult>((resolve) => {
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, (err, _out, stderr) => {
      if (!err) resolve({ ok: true, pid });
      else resolve({ ok: false, pid, reason: (stderr || err.message || 'taskkill 실패').trim() });
    });
  });
}
