import { randomBytes, createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import type { RequestHandler } from 'express';
import { ACCOUNT_RULES, type AccountRule } from './accounts.js';
import { isWithinRoot } from './browse.js';

/**
 * 접근 계정. 아이디+비밀번호 한 쌍당 접근 가능한 루트 폴더(root)를 묶는다.
 * 클라이언트는 "아이디:비밀번호" 를 합친 문자열을 토큰으로 보낸다(기존 Bearer/?token= 경로 재사용).
 * root 가 null 이면 무제한(기존 단일 토큰 동작) — 폴더 피커가 드라이브까지 올라갈 수 있다.
 * root 가 경로면 그 서브트리로 폴더 탐색·새 세션 생성·세션 목록이 제한된다(샌드박스).
 */
export interface Account {
  /** 로그인 아이디. 단일 SCREEN_TOKEN 폴백 계정은 빈 문자열(아이디 없이 토큰만 비교). */
  username: string;
  /** 자격증명 전체 — .env 계정은 "아이디:비밀번호", 폴백 계정은 토큰 원문. */
  token: string;
  root: string | null;
  label: string;
  /** 계정 식별자(=자격증명 해시). 세션 소유주 표시에 쓴다 — 비번을 평문으로 저장/노출하지 않기 위함. */
  id: string;
}

/** 자격증명 → 안정적 비밀 아닌 계정 id(해시 앞 12자). 세션 ownerId 로 저장된다. */
export function accountId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * 세션을 이 계정이 볼 수 있는가 — 세션의 작업 폴더(cwd)와 세션 자체의 샌드박스(root)가
 * 둘 다 계정 root 서브트리 안이면 보인다. cwd 만 보면 안 된다: 무제한 계정이 공유 폴더에서
 * 연 세션(root=null)이나 더 넓은 root 의 세션을 제한 계정이 조종해 샌드박스를 벗어난다.
 * root 가 없는 계정(무제한)은 전부 본다. 같은 root 를 공유하는 계정들은 서로의 세션을
 * 공유한다(협업 — 누가 만들었는지(ownerId)는 표시용일 뿐 접근 기준이 아니다).
 */
export function sessionVisibleTo(
  s: { cwd: string | null | undefined; root: string | null },
  account?: Account,
): boolean {
  if (!account || !account.root) return true;
  // cwd 를 모르거나 무제한(root=null) 세션은 샌드박스 계정에게 숨긴다(안전한 쪽으로)
  if (!s.cwd || !s.root) return false;
  return isWithinRoot(account.root, s.root) && isWithinRoot(account.root, s.cwd);
}

// req.account: requireToken 이 검증 후 주입한다.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: Account;
    }
  }
}

/** 규칙 1건 → Account 로 정규화(검증 + root 절대경로화 + label 기본값). */
function normalizeRule(r: AccountRule, i: number, seen: Set<string>): Account {
  if (typeof r.id !== 'string' || !r.id.trim()) {
    throw new Error(`규칙[${i}]: id(아이디) 필요`);
  }
  if (r.id.includes(':')) throw new Error(`규칙[${i}]: id 에 ':' 사용 불가`);
  if (typeof r.password !== 'string' || !r.password.trim()) {
    throw new Error(`규칙[${i}]: password(문자열) 필요`);
  }
  const username = r.id.trim();
  if (seen.has(username)) throw new Error(`규칙[${i}]: id 중복`);
  seen.add(username);
  const token = `${username}:${r.password}`;
  const root = typeof r.root === 'string' && r.root.trim() ? resolve(r.root) : null;
  const label =
    typeof r.label === 'string' && r.label.trim() ? r.label : root ? basename(root) : username;
  return { username, token, root, label, id: accountId(token) };
}

/**
 * 계정 목록 로드. 우선순위:
 * 1) 코드 규칙 `ACCOUNT_RULES`(src/accounts.ts) — 정식 소스. 여기를 편집한다.
 * 2) 환경변수 `SCREEN_ACCESS`(JSON 배열) — 임시 폴백(코드 규칙이 비었을 때만).
 * 3) 단일 토큰 `SCREEN_TOKEN`(없으면 랜덤, 무제한) — 아무것도 없을 때.
 */
function loadAccounts(): Account[] {
  // 1) 코드 규칙
  if (ACCOUNT_RULES.length > 0) {
    try {
      const seen = new Set<string>();
      return ACCOUNT_RULES.map((r, i) => normalizeRule(r, i, seen));
    } catch (err) {
      console.error(
        '[auth] accounts.ts 규칙 오류 — 다음 소스로 폴백:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  // 2) 환경변수(임시 폴백)
  const raw = process.env.SCREEN_ACCESS;
  if (raw && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('SCREEN_ACCESS 는 JSON 배열이어야 합니다');
      if (parsed.length === 0) throw new Error('SCREEN_ACCESS 가 비었습니다');
      const seen = new Set<string>();
      return parsed.map((e, i) => {
        const o = (e ?? {}) as Record<string, unknown>;
        return normalizeRule(
          {
            id: typeof o.id === 'string' && o.id.trim() ? o.id : `user${i + 1}`,
            password: typeof o.password === 'string' ? o.password : (o.token as string),
            root: typeof o.root === 'string' ? o.root : undefined,
            label: typeof o.label === 'string' ? o.label : undefined,
          },
          i,
          seen,
        );
      });
    } catch (err) {
      console.error(
        '[auth] SCREEN_ACCESS 파싱 실패 — 단일 토큰으로 폴백:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  // 3) 단일 토큰 — 아이디 없이 토큰 문자열만으로 로그인(하위호환)
  const token = process.env.SCREEN_TOKEN || randomBytes(4).toString('hex');
  return [{ username: '', token, root: null, label: 'full', id: accountId(token) }];
}

export const ACCOUNTS: Account[] = loadAccounts();

// 하위호환: 기존 콘솔 출력/코드가 참조하는 대표 토큰(첫 계정).
export const TOKEN = ACCOUNTS[0].token;

/** 토큰 → 계정. 없으면 null(=인증 실패). */
export function accountForToken(token: string | null): Account | null {
  if (!token) return null;
  return ACCOUNTS.find((a) => a.token === token) ?? null;
}

/** 토큰 추출: Authorization 헤더 / ?token= 쿼리 둘 다 허용(폰 편의) */
export function extractToken(req: {
  headers: Record<string, unknown>;
  query?: Record<string, unknown>;
}): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const q = req.query?.token;
  if (typeof q === 'string') return q;
  return null;
}

/** REST 보호 미들웨어 — 유효한 계정이면 req.account 에 주입 */
export const requireToken: RequestHandler = (req, res, next) => {
  const acc = accountForToken(extractToken(req));
  if (!acc) return res.status(401).json({ error: 'unauthorized' });
  req.account = acc;
  next();
};
