// 도구 실행 직전, 그 도구가 세션 루트(계정 샌드박스) 밖의 파일을 건드리는지 검사한다.
// canUseTool 에서 위험/안전 모드와 무관하게 이 검사를 먼저 돌려 루트 밖 접근을 차단한다.
//
// 한계(정직하게): 경로 인자를 가진 표준 파일 도구(Read/Write/Edit/Glob/Grep/LS 등)는
// 단단히 막지만, Bash 는 command 문자열의 '절대경로'만 best-effort 로 검사한다.
// `cat ../../secret` 같은 상대경로 탈출이나 환경변수 우회까지 완벽히 막지는 못한다.
// (그래서 제한 세션에는 프롬프트로도 "루트 밖 금지"를 주입해 방어를 겹친다.)

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithinRoot } from './browse.js';

// 경로 값을 직접 갖는 도구 인자 키들.
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

// 루트 밖이어도 항상 허용하는 경로들.
// - 하네스(Claude Code)가 백그라운드 작업 출력을 쓰는 temp/claude 디렉터리:
//   run_in_background 로그를 세션이 스스로 읽으려면 필요하다.
// - SESSION_ALLOW_PATHS 환경변수(세미콜론 구분)로 더 추가할 수 있다.
function allowedPaths(): string[] {
  const list = [join(tmpdir(), 'claude')];
  const extra = process.env.SESSION_ALLOW_PATHS;
  if (extra) {
    for (const p of extra.split(';')) {
      const t = p.trim();
      if (t) list.push(t);
    }
  }
  return list;
}

/** target 이 allowlist 중 하나의 서브트리 안이면 true(루트 밖이어도 허용). */
function isAllowlisted(target: string): boolean {
  return allowedPaths().some((p) => isWithinRoot(p, target));
}

// 윈도우 절대경로(C:\... / c:/...) 및 UNC(\\server\...)를 대충 뽑아내는 정규식.
// 명령 구분자/따옴표 앞까지만 경로로 본다.
const WIN_ABS = /(?:[a-zA-Z]:[\\/]|\\\\)[^\s"'`|&;<>()]*/g;

/** Bash command 문자열에서 루트 밖 절대경로를 찾으면 그 경로, 없으면 null. */
function offendingBashPath(command: string, root: string): string | null {
  const matches = command.match(WIN_ABS);
  if (!matches) return null;
  for (const m of matches) {
    if (!isWithinRoot(root, m) && !isAllowlisted(m)) return m;
  }
  return null;
}

/**
 * 루트 밖 파일을 건드리는 도구 호출이면 그 경로 문자열을 반환, 안전하면 null.
 * root 가 null(무제한 계정)이면 항상 null.
 */
export function offendingToolPath(
  toolName: string,
  input: unknown,
  root: string | null,
): string | null {
  if (!root) return null;
  const o = (input ?? {}) as Record<string, unknown>;

  // 1) 경로 인자를 직접 갖는 도구들 — 단단히 검사.
  for (const key of PATH_KEYS) {
    const v = o[key];
    if (typeof v === 'string' && v.trim() && !isWithinRoot(root, v) && !isAllowlisted(v))
      return v;
  }

  // 2) Bash — command 안의 절대경로만 best-effort 검사.
  if (toolName === 'Bash' && typeof o.command === 'string') {
    return offendingBashPath(o.command, root);
  }

  return null;
}
