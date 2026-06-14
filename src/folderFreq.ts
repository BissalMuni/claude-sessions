// 폴더 사용 빈도(자주 여는 프로젝트)를 서버에 영속 저장한다.
// 이전에는 브라우저 localStorage 에 기기별로 쌓였지만, 이제 서버의
// JSON 파일에 모아 모든 기기(SPA·lite)가 같은 빈도를 공유한다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ 든 dist/ 든 어디서 실행되어도 프로젝트 루트의 .data/ 를 가리킨다.
const DATA_DIR = join(__dirname, '..', '.data');
const FREQ_FILE = join(DATA_DIR, 'folder-freq.json');

// 메모리 캐시. 첫 접근 시 디스크에서 1회 로드한다.
let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (cache) return cache;
  let next: Record<string, number>;
  try {
    const parsed = JSON.parse(readFileSync(FREQ_FILE, 'utf8'));
    next = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    next = {}; // 파일 없음/손상 → 빈 맵으로 시작
  }
  cache = next;
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
  const key = String(path || '').trim();
  if (!key) return;
  const f = load();
  f[key] = (f[key] || 0) + 1;
  persist();
}

/** 현재 빈도 맵(경로→횟수)의 사본 */
export function getFolderFreq(): Record<string, number> {
  return { ...load() };
}
