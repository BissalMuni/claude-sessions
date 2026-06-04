import { Router } from 'express';
import { requireToken } from './auth.js';
import { browse } from './browse.js';
import type { SessionManager } from './sessionManager.js';

/** REST 라우트 (전부 토큰 필요) */
export function createApiRouter(manager: SessionManager): Router {
  const router = Router();
  router.use(requireToken);

  // 서버(PC) 폴더 탐색 — 폴더 피커용
  router.get('/browse', (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(browse(path));
  });

  // 세션 목록
  router.get('/sessions', (_req, res) => {
    res.json({ sessions: manager.list() });
  });

  // 새 세션 생성
  router.post('/sessions', (req, res) => {
    const { cwd, title } = req.body ?? {};
    if (typeof cwd !== 'string' || !cwd.trim()) {
      return res.status(400).json({ error: 'cwd가 필요합니다' });
    }
    const view = manager.create({ cwd, title });
    res.status(201).json({ session: view });
  });

  // 단일 세션 상세
  router.get('/sessions/:id', (req, res) => {
    const view = manager.get(req.params.id);
    if (!view) return res.status(404).json({ error: 'not found' });
    res.json({ session: view });
  });

  // 명령 주입
  router.post('/sessions/:id/prompt', (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text가 필요합니다' });
    }
    if (!manager.sendPrompt(req.params.id, text)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  // 승인/거부
  router.post('/sessions/:id/approve', (req, res) => {
    const { requestId, decision } = req.body ?? {};
    if (decision !== 'yes' && decision !== 'no') {
      return res.status(400).json({ error: "decision은 'yes'|'no'" });
    }
    if (typeof requestId !== 'string') {
      return res.status(400).json({ error: 'requestId가 필요합니다' });
    }
    if (!manager.approve(requestId, decision)) {
      return res.status(409).json({ error: '대기 중인 요청이 아님(이미 처리/만료)' });
    }
    res.json({ ok: true });
  });

  // 진행 중 턴 중단
  router.post('/sessions/:id/interrupt', async (req, res) => {
    if (!(await manager.interrupt(req.params.id))) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  // 세션 종료
  router.delete('/sessions/:id', (req, res) => {
    if (!manager.remove(req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  return router;
}
