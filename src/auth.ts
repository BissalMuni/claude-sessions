import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';

// 서버 시작 시 토큰을 정한다. 환경변수 SCREEN_TOKEN 이 있으면 그걸 쓰고,
// 없으면 랜덤 생성해 콘솔에 출력한다(폰에 1회 입력).
export const TOKEN = process.env.SCREEN_TOKEN || randomBytes(4).toString('hex');

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

/** REST 보호 미들웨어 */
export const requireToken: RequestHandler = (req, res, next) => {
  if (extractToken(req) === TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
};
