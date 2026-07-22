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
  /** 계정 샌드박스 루트(null=무제한). 복원 시 도구 경로 검사 기준을 잃지 않도록 함께 저장. */
  root?: string | null;
  /** 세션 소유 계정 id(null/미지정=레거시/공유). 복원 후에도 격리를 유지하도록 저장. */
  ownerId?: string | null;
  sdkSessionId: string | null; // null 이면 resume 불가 → 빈 컨텍스트로 새로 시작
  // 폰에 보여줄 표시용 기록. 종료(ended)된 세션은 []로 비운다(실제 대화는 SDK 트랜스크립트에 있음).
  messages: StreamItem[];
  createdAt: string;
  updatedAt: string;
  /**
   * 종료(보관)됨. true 면 기록은 남기되 재기동 시 활성 세션으로 복원하지 않는다.
   * (사용자가 '종료'한 세션 = 연속성 대상 아님. 기록/감사는 보존.)
   */
  ended?: boolean;
}

// 메모리 캐시. 첫 접근 시 디스크에서 1회 로드한다.
let cache: Map<string, PersistedSession> | null = null;
// 디바운스 타이머: onUpdate 가 자주 불리므로 즉시 쓰지 않고 모아서 1번 쓴다.
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, PersistedSession> {
  if (cache) return cache;
  const map = new Map<string, PersistedSession>();
  let pruned = false;
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (r && typeof r.id === 'string') {
          // 종료(보관)된 세션은 메시지를 보관하지 않는다(메타데이터만 유지).
          // 실제 대화는 SDK 트랜스크립트(~/.claude/projects)에 남으므로 감사 손실 없음.
          // 이 청소가 과거에 쌓인 종료 세션 메시지를 부팅 1회에 걷어내 파일을 줄인다.
          if (r.ended && Array.isArray(r.messages) && r.messages.length > 0) {
            r.messages = [];
            pruned = true;
          }
          map.set(r.id, r as PersistedSession);
        }
      }
    }
  } catch {
    /* 파일 없음/손상 → 빈 맵으로 시작 */
  }
  cache = map;
  if (pruned) scheduleWrite(); // 걷어낸 결과를 디스크에 반영(디바운스)
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
  const prev = map.get(view.id);
  map.set(view.id, {
    id: view.id,
    title: view.title,
    cwd: view.cwd,
    root: view.root ?? null,
    ownerId: view.ownerId ?? null,
    sdkSessionId: view.sdkSessionId,
    // 종료된 세션은 메시지를 보관하지 않는다(방어: 뒤늦은 저장이 스트립을 되돌리지 않게).
    messages: prev?.ended ? [] : view.messages,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    // 한 번 종료(보관) 표시된 세션은 이후 저장에서도 그 상태를 잃지 않게 보존.
    ...(prev?.ended ? { ended: true } : {}),
  });
  scheduleWrite();
}

/** 세션 종료(보관) 표시 → 기록은 남기되 재기동 시 복원 대상에서 제외. */
export function markEnded(id: string): void {
  const map = load();
  const rec = map.get(id);
  if (!rec || rec.ended) return;
  rec.ended = true;
  rec.messages = []; // 종료 세션은 메시지 보관 안 함(메타데이터만) → 파일 비대 방지
  scheduleWrite();
}

/** 세션 제거 → 저장소에서도 완전 삭제(기록도 사라짐). */
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
