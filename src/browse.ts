import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, parse } from 'node:path';

export interface BrowseResult {
  path: string; // 현재 경로 ('' = 드라이브 목록)
  parent: string | null; // 상위 경로 (없으면 null)
  dirs: string[]; // 하위 디렉터리 전체 경로
  isRoot: boolean; // 드라이브 목록 화면인지
  error: string | null;
}

/** 새 세션 피커가 처음 열릴 때 시작할 폴더. 없으면 드라이브 목록('')으로 폴백 */
export function defaultStartPath(): string {
  const dir = process.env.SCREEN_START_DIR || 'D:\\Coding';
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

/** 주어진 경로의 하위 디렉터리들을 나열. path 가 비면 드라이브 목록 */
export function browse(path: string): BrowseResult {
  if (!path) {
    return { path: '', parent: null, dirs: listDrives(), isRoot: true, error: null };
  }
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith('.')) return false; // 숨김 폴더 제외
        return true;
      })
      .map((e) => join(path, e.name))
      .sort((a, b) => a.localeCompare(b));

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
