// 컨트롤러 서버 자체 재시작.
//
// 핵심: **서버는 스스로를 되살릴 수 없다.** 죽은 프로세스는 아무 일도 못 하므로
// "자기를 죽이고 자기를 살리기"는 성립하지 않는다. 되살리는 주체는 start-server.bat 를
// 돌리는 cmd.exe 창이다 — 그 창은 node 가 아니라서 node 가 죽어도 살아남고, :loop 가
// 3초 뒤 같은 명령을 다시 실행한다(원래는 에이전트가 taskkill 로 컨트롤러를 날렸을 때
// 복구하라고 만든 장치인데, 그대로 '재시작' 수단이 된다).
//
// 그래서 재시작 = ① 정상 종료(exit 0) + ② 감시자가 다시 띄워주기, 두 단계다.
// ②가 없는 기동 방식(pnpm start 를 직접 실행, 숨은 PowerShell 에서 node 직접 실행 등)에서
// ①만 하면 서버는 그냥 영영 죽는다. 폰에서 눌렀다면 되살릴 방법이 아예 없다
// (컨트롤러가 죽었으니 컨트롤러로는 못 띄운다). 그래서 **누르기 전에 감시자를 확인하고,
// 없으면 거부한다.** 이게 이 모듈의 존재 이유다.

import { execFile } from 'node:child_process';

/** 부모 체인에서 이 문자열을 커맨드라인에 가진 프로세스를 감시자로 본다. */
const SUPERVISOR_HINT = 'start-server.bat';
/** 부모를 몇 단계까지 거슬러 올라갈지 (node → tsx cli → cmd → explorer 정도라 넉넉하다). */
const MAX_DEPTH = 8;
/** 응답이 폰에 도착할 시간을 준 뒤 죽는다. 먼저 끊으면 폰은 네트워크 오류로 본다. */
export const RESTART_DELAY_MS = 400;

export interface SupervisorInfo {
  /** 감시자를 찾았는가 = 재시작해도 다시 살아나는가. */
  ok: boolean;
  /** 감시자 프로세스 PID. */
  pid?: number;
  /** 감시자 커맨드라인(표시용, 길면 잘림). */
  via?: string;
  /** ok=false 일 때 사람이 읽을 이유. */
  reason?: string;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout || '');
    });
  });
}

/**
 * 내 PID 에서 부모를 거슬러 올라가며 start-server.bat 를 돌리는 창을 찾는다.
 * Win32_Process 한 방에 체인을 다 뽑아 PowerShell 기동 비용(~0.5s)을 한 번만 낸다.
 */
export async function findSupervisor(): Promise<SupervisorInfo> {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Windows 전용 기능입니다 (감시자가 start-server.bat 의 cmd 창이라서)' };
  }
  const script = [
    `$p = ${process.pid};`,
    `for ($i = 0; $i -lt ${MAX_DEPTH} -and $p -and $p -ne 0; $i++) {`,
    `  $o = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;`,
    `  if (-not $o) { break }`,
    `  "$($o.ProcessId)|$($o.CommandLine)";`,
    `  $p = $o.ParentProcessId`,
    `}`,
  ].join(' ');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out.trim()) {
    return { ok: false, reason: '부모 프로세스 체인을 조회하지 못했습니다 (PowerShell 실행 실패)' };
  }
  for (const line of out.split(/\r?\n/)) {
    const sep = line.indexOf('|');
    if (sep < 0) continue;
    const pid = Number(line.slice(0, sep));
    const cmd = line.slice(sep + 1).trim();
    if (!cmd.toLowerCase().includes(SUPERVISOR_HINT)) continue;
    return { ok: true, pid, via: cmd.length > 160 ? cmd.slice(0, 160) + '…' : cmd };
  }
  return {
    ok: false,
    reason:
      `감시자(${SUPERVISOR_HINT})가 부모 체인에 없습니다. 지금 종료하면 서버가 다시 뜨지 않습니다. ` +
      `start-server.bat 로 띄운 창에서만 재시작할 수 있습니다.`,
  };
}

// server.ts 가 자기 종료 절차를 여기에 꽂아둔다. api.ts 가 server.ts 를 직접 import 하면
// 순환 참조가 되므로(server → api → server), 이 모듈을 가운데 둔다.
type ShutdownFn = (reason: string) => void;
let shutdownFn: ShutdownFn | null = null;

/** server.ts 전용: 정상 종료 절차를 등록한다. */
export function registerShutdown(fn: ShutdownFn): void {
  shutdownFn = fn;
}

/**
 * 재시작 요청. 호출 즉시 죽지 않고 RESTART_DELAY_MS 뒤에 정상 종료한다
 * (HTTP 응답이 먼저 나가야 폰이 '성공'으로 받는다). 이후는 감시자 몫.
 */
export function requestRestart(reason: string): boolean {
  if (!shutdownFn) return false;
  const fn = shutdownFn;
  const t = setTimeout(() => fn(reason), RESTART_DELAY_MS);
  if (typeof t.unref === 'function') t.unref();
  return true;
}
