// 폴더 사용 빈도(자주 여는 프로젝트)를 서버에 영속 저장한다.
// 이전에는 브라우저 localStorage 에 기기별로 쌓였지만, 이제 서버의
// JSON 파일에 모아 모든 기기가 같은 빈도를 공유한다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ 든 dist/ 든 어디서 실행되어도 프로젝트 루트의 .data/ 를 가리킨다.
const DATA_DIR = join(__dirname, '..', '.data');
const FREQ_FILE = join(DATA_DIR, 'folder-freq.json');

// 메모리 캐시. 첫 접근 시 디스크에서 1회 로드한다.
let cache: Record<string, number> | null = null;

// 같은 폴더가 여러 줄로 갈라지는 것을 막는다. 구분자(`/` vs `\`)와 끝 슬래시를
// 통일한 표기를 만든다. 표시용이므로 대소문자는 입력 그대로 둔다.
function normalizeKey(path: string): string {
  let key = String(path || '').trim().replace(/\//g, '\\');
  key = key.replace(/\\+$/, ''); // 끝 슬래시 제거 (단 `C:` 는 아래에서 복원)
  if (/^[A-Za-z]:$/.test(key)) key += '\\'; // 드라이브 루트는 `C:\` 형태 유지
  return key;
}

// 묶음용 키. Windows 경로는 드라이브 문자뿐 아니라 경로 전체가 대소문자를
// 구분하지 않으므로(`C:\users\...` 와 `C:\Users\...` 는 같은 폴더),
// 소문자로 접어서 비교해야 한 폴더가 한 줄로 모인다.
function foldKey(path: string): string {
  return normalizeKey(path).toLowerCase();
}

function load(): Record<string, number> {
  if (cache) return cache;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(FREQ_FILE, 'utf8'));
    raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    raw = {}; // 파일 없음/손상 → 빈 맵으로 시작
  }

  // 기존 파일에 이미 쌓인 중복 키를 합산하며 읽어들인다(자가 치유).
  // 빈도 카운터이므로 합산이 올바른 병합이다. 표시 경로는 가장 많이 쓰인
  // 표기를 채택한다(같으면 먼저 나온 쪽).
  const groups = new Map<string, { display: string; top: number; total: number }>();
  let merged = false;
  for (const [k, v] of Object.entries(raw)) {
    const count = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const display = normalizeKey(k);
    if (!display) continue;
    const fold = display.toLowerCase();
    const g = groups.get(fold);
    if (!g) {
      groups.set(fold, { display, top: count, total: count });
      if (display !== k) merged = true;
    } else {
      g.total += count;
      merged = true;
      if (count > g.top) {
        g.top = count;
        g.display = display;
      }
    }
  }

  const next: Record<string, number> = {};
  for (const g of groups.values()) next[g.display] = g.total;

  cache = next;
  if (merged) persist(); // 정규화 결과를 디스크에도 반영
  return next;
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FREQ_FILE, JSON.stringify(cache ?? {}, null, 2));
  } catch {
    /* 디스크 오류는 무시: 빈도는 부가기능이라 세션 생성을 막지 않는다 */
  }
}

/** 폴더로 세션을 만들 때마다 +1 (피커가 빈도순으로 위에 올리는 용도) */
export function bumpFolderFreq(path: string): void {
  const key = normalizeKey(path);
  if (!key) return;
  const f = load();
  // 대소문자만 다른 같은 폴더가 이미 있으면 그 줄을 올린다(새 줄을 만들지 않는다).
  const fold = key.toLowerCase();
  const existing = Object.keys(f).find((k) => k.toLowerCase() === fold) ?? key;
  f[existing] = (f[existing] || 0) + 1;
  persist();
}

/** 현재 빈도 맵(경로→횟수)의 사본 */
export function getFolderFreq(): Record<string, number> {
  return { ...load() };
}
