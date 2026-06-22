// 세션 메타/기록을 디스크에 영속 저장한다. 서버 재시작 후 SDK resume 으로
// 대화를 복원하기 위함. folderFreq 와 같은 .data/ 디렉터리에 sessions.json 으로 저장.
//
// SDK 자체는 대화 transcript 를 ~/.claude/projects/ 에 남기지만(resume 의 실제 소스),
// 서버는 "어떤 세션이 어떤 cwd/sdkSessionId 로 살아있었는지 + 폰에 보여줄 기록"을
// 알아야 재기동 후 그 세션들을 다시 띄울 수 있다. 그 인덱스를 여기에 저장한다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionView, StreamItem } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ 든 dist/ 든 어디서 실행되어도 프로젝트 루트의 .data/ 를 가리킨다.
const DATA_DIR = join(__dirname, '..', '.data');
const STORE_FILE = join(DATA_DIR, 'sessions.json');

/** 디스크에 저장되는 세션 1건 (resume + 기록 복원에 필요한 최소 정보) */
export interface PersistedSession {
  id: string;
  title: string;
  cwd: string;
  sdkSessionId: string | null; // null 이면 resume 불가 → 빈 컨텍스트로 새로 시작
  messages: StreamItem[];
  createdAt: string;
  updatedAt: string;
}

// 메모리 캐시. 첫 접근 시 디스크에서 1회 로드한다.
let cache: Map<string, PersistedSession> | null = null;
// 디바운스 타이머: onUpdate 가 자주 불리므로 즉시 쓰지 않고 모아서 1번 쓴다.
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, PersistedSession> {
  if (cache) return cache;
  const map = new Map<string, PersistedSession>();
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (r && typeof r.id === 'string') map.set(r.id, r as PersistedSession);
      }
    }
  } catch {
    /* 파일 없음/손상 → 빈 맵으로 시작 */
  }
  cache = map;
  return map;
}

function writeNow(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify([...(cache ?? new Map()).values()], null, 2));
  } catch {
    /* 디스크 오류는 무시: 영속화는 부가기능이라 세션 동작을 막지 않는다 */
  }
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
  }, 1000);
  // 디스크 쓰기 타이머가 프로세스 종료를 붙잡지 않게 한다.
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/** 복원용: 저장된 모든 세션을 updatedAt(오래된→최신)으로 정렬해 반환 */
export function loadPersistedSessions(): PersistedSession[] {
  return [...load().values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** 세션 스냅샷을 저장(디바운스). resume 에 필요한 핵심 필드만 추린다. */
export function saveSession(view: SessionView): void {
  const map = load();
  map.set(view.id, {
    id: view.id,
    title: view.title,
    cwd: view.cwd,
    sdkSessionId: view.sdkSessionId,
    messages: view.messages,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  });
  scheduleWrite();
}

/** 세션 제거 → 저장소에서도 삭제 */
export function deleteSession(id: string): void {
  if (load().delete(id)) scheduleWrite();
}

/** 종료 시 즉시 동기 기록 (디바운스 무시). */
export function flushSessions(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  writeNow();
}
