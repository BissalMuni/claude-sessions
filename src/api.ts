import { Router } from 'express';
import { requireToken } from './auth.js';
import { browse, defaultStartPath } from './browse.js';
import { saveUploads } from './uploads.js';
import { getFolderFreq } from './folderFreq.js';
import type { SessionManager } from './sessionManager.js';
import type { InputFile, InputImage } from './types.js';

/** 폰이 보낸 images 페이로드 검증. 형식 오류면 null, 없으면 [] */
function parseImages(raw: unknown): InputImage[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: InputImage[] = [];
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    if (typeof o.mediaType !== 'string' || typeof o.data !== 'string') return null;
    if (!o.mediaType.startsWith('image/') || o.data.length === 0) return null;
    out.push({ mediaType: o.mediaType, data: o.data });
  }
  return out;
}

/** 폰이 보낸 files(임의 파일) 페이로드 검증. 형식 오류면 null, 없으면 [] */
function parseFiles(raw: unknown): InputFile[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: InputFile[] = [];
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.data !== 'string') return null;
    if (!o.name.trim() || o.data.length === 0) return null;
    out.push({ name: o.name, data: o.data, mediaType: typeof o.mediaType === 'string' ? o.mediaType : undefined });
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** REST 라우트 (전부 토큰 필요) */
export function createApiRouter(manager: SessionManager): Router {
  const router = Router();
  router.use(requireToken);

  // 서버(PC) 폴더 탐색 — 폴더 피커용
  router.get('/browse', (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(browse(path));
  });

  // 피커가 처음 열릴 때 시작할 폴더 — 서버에서 자동 계산해 SPA 에 알려준다.
  // (클라이언트에 경로를 하드코딩하지 않기 위함. 비면 SPA 가 드라이브 목록으로 폴백)
  router.get('/start-dir', (_req, res) => {
    res.json({ path: defaultStartPath() });
  });

  // 폴더 사용 빈도(경로→횟수) — 피커가 자주 연 폴더를 위로 올리는 데 사용
  router.get('/folder-freq', (_req, res) => {
    res.json({ freq: getFolderFreq() });
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

  // 명령 주입 (텍스트 + 선택적 이미지 인라인 + 선택적 파일 업로드)
  router.post('/sessions/:id/prompt', (req, res) => {
    const { text, images, files } = req.body ?? {};
    const t = typeof text === 'string' ? text : '';
    const imgs = parseImages(images);
    if (imgs === null) {
      return res.status(400).json({ error: 'images 형식 오류 (mediaType/data 필요)' });
    }
    const fls = parseFiles(files);
    if (fls === null) {
      return res.status(400).json({ error: 'files 형식 오류 (name/data 필요)' });
    }
    if (!t.trim() && imgs.length === 0 && fls.length === 0) {
      return res.status(400).json({ error: 'text 또는 images 또는 files가 필요합니다' });
    }

    // 세션 cwd 를 알아야 파일을 저장할 수 있다 (존재 확인 겸)
    const view = manager.get(req.params.id);
    if (!view) return res.status(404).json({ error: 'not found' });

    // 업로드 파일은 cwd/.uploads/ 에 저장하고, 경로를 프롬프트에 덧붙여 Claude 가 읽게 한다.
    let finalText = t;
    if (fls.length > 0) {
      let saved;
      try {
        saved = saveUploads(view.cwd, fls);
      } catch (e) {
        return res.status(500).json({ error: '파일 저장 실패: ' + (e instanceof Error ? e.message : String(e)) });
      }
      const list = saved.map((s) => `- ${s.relPath} (${fmtBytes(s.bytes)})`).join('\n');
      const note = `[업로드된 파일 ${saved.length}개]\n${list}`;
      finalText = t.trim() ? `${t}\n\n${note}` : `다음 업로드된 파일을 확인해줘:\n${note}`;
    }

    if (!manager.sendPrompt(req.params.id, finalText, imgs)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true, files: fls.length });
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

  // AskUserQuestion 선택 응답
  router.post('/sessions/:id/answer', (req, res) => {
    const { requestId, answers } = req.body ?? {};
    if (typeof requestId !== 'string') {
      return res.status(400).json({ error: 'requestId가 필요합니다' });
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers(객체)가 필요합니다' });
    }
    if (!manager.answer(requestId, answers as Record<string, string>)) {
      return res.status(409).json({ error: '대기 중인 질문이 아님(이미 처리/만료)' });
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
