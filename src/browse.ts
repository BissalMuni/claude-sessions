import { readdirSync, existsSync } from 'node:fs';
import { join, parse, dirname, resolve, relative, isAbsolute } from 'node:path';

export interface BrowseResult {
  path: string; // 현재 경로 ('' = 드라이브 목록)
  parent: string | null; // 상위 경로 (없으면 null)
  dirs: string[]; // 하위 디렉터리 전체 경로
  isRoot: boolean; // 드라이브 목록 화면인지
  error: string | null;
}

/**
 * target 이 root 서브트리 안(또는 root 자신)인지.
 * root 가 null 이면 제한 없음(항상 true). Windows 는 대소문자 무시.
 */
export function isWithinRoot(root: string | null, target: string): boolean {
  if (!root) return true;
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 새 세션 피커가 처음 열릴 때 시작할 폴더.
 * - root 가 주어지면(샌드박스 계정) 그 폴더에서 시작.
 * - root 가 null 이면 SCREEN_START_DIR 또는 서버 cwd 의 부모(여러 프로젝트 상위 폴더).
 * 없으면 드라이브 목록('')으로 폴백.
 */
export function defaultStartPath(root: string | null = null): string {
  if (root) return existsSync(root) ? resolve(root) : '';
  const dir = process.env.SCREEN_START_DIR || dirname(process.cwd());
  return existsSync(dir) ? dir : '';
}

/** 윈도우 드라이브 목록 (C:\ D:\ …) */
function listDrives(): string[] {
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) out.push(root);
  }
  return out;
}

/** 주어진 경로의 하위 디렉터리들을 나열 (숨김 폴더 제외, 이름순) */
function listDirs(path: string): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(path, e.name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 폴더 탐색.
 * @param path 열 경로. 비면 드라이브 목록(무제한) 또는 루트(샌드박스).
 * @param root null 이면 무제한. 경로면 그 서브트리 밖으로 못 나감(밖/빈 경로는 루트로 스냅).
 */
export function browse(path: string, root: string | null = null): BrowseResult {
  // --- 샌드박스: 루트 밖/빈 경로는 전부 루트로 스냅, 루트 위로는 못 감 ---
  if (root) {
    const rootAbs = resolve(root);
    const cur = path && isWithinRoot(rootAbs, path) ? resolve(path) : rootAbs;
    try {
      const dirs = listDirs(cur);
      // 루트 자신이면 위로 없음(null). 아니면 부모 — 단 부모가 루트 밖이면 null 로 막는다.
      let parent: string | null = null;
      if (cur !== rootAbs) {
        const p = parse(cur);
        parent = p.dir && p.dir !== cur && isWithinRoot(rootAbs, p.dir) ? p.dir : rootAbs;
      }
      return { path: cur, parent, dirs, isRoot: false, error: null };
    } catch (err) {
      return {
        path: cur,
        parent: cur === rootAbs ? null : rootAbs,
        dirs: [],
        isRoot: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- 무제한(전체 접근 계정) ---
  if (!path) {
    return { path: '', parent: null, dirs: listDrives(), isRoot: true, error: null };
  }
  try {
    const dirs = listDirs(path);
    // 상위: 드라이브 루트(C:\)면 드라이브 목록으로, 아니면 부모 디렉터리
    const p = parse(path);
    const parent = p.dir && p.dir !== path ? p.dir : '';
    return { path, parent, dirs, isRoot: false, error: null };
  } catch (err) {
    return {
      path,
      parent: '',
      dirs: [],
      isRoot: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
