import { randomBytes, createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import type { RequestHandler } from 'express';
import { ACCOUNT_RULES, type AccountRule } from './accounts.js';

/**
 * 접근 계정. 비밀번호(=토큰) 하나당 접근 가능한 루트 폴더(root)를 묶는다.
 * root 가 null 이면 무제한(기존 단일 토큰 동작) — 폴더 피커가 드라이브까지 올라갈 수 있다.
 * root 가 경로면 그 서브트리로 폴더 탐색·새 세션 생성이 제한된다(샌드박스).
 */
export interface Account {
  token: string;
  root: string | null;
  label: string;
  /** 계정 식별자(=토큰 해시). 세션 소유주 표시에 쓴다 — 비번을 평문으로 저장/노출하지 않기 위함. */
  id: string;
}

/** 토큰 → 안정적 비밀 아닌 계정 id(해시 앞 12자). 세션 ownerId 로 저장된다. */
export function accountId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * 세션을 이 계정이 볼 수 있는가.
 * - ownerId 가 없으면(레거시/단일토큰 시절 세션) 모두에게 보인다.
 * - 있으면 소유 계정만 본다(계정별 세션 격리).
 */
export function sessionVisibleTo(ownerId: string | null | undefined, account?: Account): boolean {
  if (!ownerId) return true;
  return account?.id === ownerId;
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
  if (typeof r.password !== 'string' || !r.password.trim()) {
    throw new Error(`규칙[${i}]: password(문자열) 필요`);
  }
  if (seen.has(r.password)) throw new Error(`규칙[${i}]: password 중복`);
  seen.add(r.password);
  const root = typeof r.root === 'string' && r.root.trim() ? resolve(r.root) : null;
  const label =
    typeof r.label === 'string' && r.label.trim() ? r.label : root ? basename(root) : 'full';
  return { token: r.password, root, label, id: accountId(r.password) };
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
  // 3) 단일 토큰
  const token = process.env.SCREEN_TOKEN || randomBytes(4).toString('hex');
  return [{ token, root: null, label: 'full', id: accountId(token) }];
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
