// 세션 에러를 .data/errors.jsonl 에 append-only 로 남긴다.
//
// 왜 필요한가: 지금까지 에러는 폰 화면(addItem('error'))과 in-memory 카운터
// (consumeRetries/streamRetryTotal)에만 존재해서 서버를 재시작하면 통째로 사라졌다.
// 특히 재시도로 복구된 에러는 system 아이템으로만 남아 MAX_MESSAGES=300 캡에 밀려
// 지워졌는데, 실제로 가장 자주 나는 게 바로 그 경로다. 그래서 "무슨 에러가 얼마나
// 자주 나는지"를 사후에 셀 수 없었다.
//
// jsonl 인 이유: 한 줄 = 한 사건이라 append 가 원자적이고(부분 쓰기로 파일 전체가
// 깨지지 않음), 재시작을 넘어 누적되며, jq 나 grep 으로 바로 집계된다.
// 예) 원인별 빈도:  jq -r .message .data/errors.jsonl | sort | uniq -c | sort -rn

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ 든 dist/ 든 어디서 실행되어도 프로젝트 루트의 .data/ 를 가리킨다.
const DATA_DIR = join(__dirname, '..', '.data');
const FILE = join(DATA_DIR, 'errors.jsonl');
// 이 크기를 넘으면 errors.jsonl.1 로 밀어내고 새로 시작한다(무한 증가 방지).
// 한 건이 ~300B 라 5MB 면 대략 1.7만 건 — 빈도 분석에 차고 넘친다.
const MAX_BYTES = 5 * 1024 * 1024;

/** 에러 1건. 사후 상관분석에 필요한 맥락을 통째로 붙여 남긴다. */
export interface ErrorRecord {
  at: string; // ISO 시각
  sessionId: string;
  title: string;
  cwd: string;
  /**
   * 감지 경로. 셋은 서로 다른 실패라 집계할 때 반드시 구분해야 한다.
   * throw=이터레이터 예외 / result=비정상 종료 / text=CLI 가 텍스트로 뱉은 문구
   * compaction=컴팩션 설정 실패 / context=컨텍스트 조회 실패
   */
  src: 'throw' | 'result' | 'text' | 'compaction' | 'context';
  message: string;
  /** 재시도 대상으로 판정됐나 (throw 경로에서만 의미 있음) */
  retryable?: boolean;
  /** 이 세션의 연속 재시도 횟수 */
  retry?: number;
  /** 이 세션의 누적 재시도 횟수 (성공해도 리셋 안 함) */
  retryTotal?: number;
  /** 끊긴 순간 돌던 도구 */
  lastTool?: string | null;
  /** 그때의 컨텍스트 토큰 (-1=미상) */
  ctxTokens?: number;
  /** 턴 시작 후 경과 ms (-1=턴 밖) */
  elapsedMs?: number;
}

/** 파일이 커지면 한 세대만 밀어낸다. 실패해도 기록은 계속 시도한다. */
function rotateIfNeeded(): void {
  try {
    if (statSync(FILE).size < MAX_BYTES) return;
    renameSync(FILE, FILE + '.1');
  } catch {
    /* 파일 없음/회전 실패 → 그냥 계속 append */
  }
}

/** 에러 1건 기록. 로깅 실패가 세션을 죽이면 안 되므로 전부 삼킨다. */
export function recordError(rec: ErrorRecord): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(FILE, JSON.stringify(rec) + '\n');
  } catch {
    /* 영속화는 부가기능이라 세션 동작을 막지 않는다 */
  }
}

/** 최근 N건을 최신순으로 읽는다 (진단 API/CLI 집계용). 손상된 줄은 건너뛴다. */
export function readRecentErrors(limit = 200): ErrorRecord[] {
  try {
    const lines = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const out: ErrorRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as ErrorRecord);
      } catch {
        /* 부분 쓰기로 깨진 줄은 무시 */
      }
    }
    return out;
  } catch {
    return [];
  }
}
