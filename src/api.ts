import { Router } from 'express';
import { requireToken } from './auth.js';
import { browse, defaultStartPath, isWithinRoot } from './browse.js';
import { auxStatus, startAux, stopAux, type AuxKind } from './auxServers.js';
import { saveUploads } from './uploads.js';
import { getFolderFreq } from './folderFreq.js';
import { serverStatus } from './servers.js';
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

  // 서버(PC) 폴더 탐색 — 폴더 피커용 (계정 루트로 제한)
  router.get('/browse', (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(browse(path, req.account?.root ?? null));
  });

  // 피커가 처음 열릴 때 시작할 폴더 — 서버에서 자동 계산해 SPA 에 알려준다.
  // (클라이언트에 경로를 하드코딩하지 않기 위함. 비면 SPA 가 드라이브 목록으로 폴백)
  // 샌드박스 계정이면 그 루트에서 시작한다.
  router.get('/start-dir', (req, res) => {
    res.json({ path: defaultStartPath(req.account?.root ?? null) });
  });

  // 폴더 사용 빈도(경로→횟수) — 피커가 자주 연 폴더를 위로 올리는 데 사용
  router.get('/folder-freq', (_req, res) => {
    res.json({ freq: getFolderFreq() });
  });

  // 위험 모드 조회
  router.get('/danger', (_req, res) => {
    res.json({ danger: manager.isDanger() });
  });

  // 보조 서버(정적/업로드) 상태 조회
  router.get('/aux', (_req, res) => {
    res.json({ aux: auxStatus() });
  });

  // 로컬 서버 현황 — 이 PC 에서 LISTEN 중인 포트(알려진 고정 서버 + 기타)
  router.get('/servers', async (_req, res) => {
    try {
      res.json(await serverStatus());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 보조 서버 열기/닫기 — 정적 파일 서버 또는 업로드 서버.
  // body: { kind:'static'|'upload', action:'start'|'stop', dir?, port? }
  router.post('/aux', async (req, res) => {
    const { kind, action, dir, port } = req.body ?? {};
    if (kind !== 'static' && kind !== 'upload') {
      return res.status(400).json({ error: "kind는 'static'|'upload'" });
    }
    try {
      if (action === 'stop') {
        await stopAux(kind as AuxKind);
      } else if (action === 'start') {
        if (typeof dir !== 'string' || !dir.trim()) {
          return res.status(400).json({ error: '대상 폴더(dir)가 필요합니다' });
        }
        // 샌드박스: 이 계정의 root 밖 폴더는 서빙/업로드 대상이 될 수 없다.
        if (!isWithinRoot(req.account?.root ?? null, dir)) {
          return res.status(403).json({ error: '이 계정은 해당 폴더에 접근할 수 없습니다' });
        }
        const p = typeof port === 'number' && port > 0 ? port : undefined;
        await startAux(kind as AuxKind, dir, p);
      } else {
        return res.status(400).json({ error: "action은 'start'|'stop'" });
      }
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
    // 모든 기기에 상태 동기화(WS) + 응답
    const aux = auxStatus();
    manager.broadcastAux(aux);
    res.json({ aux });
  });

  // 위험 모드 토글 (폰 ON/OFF 스위치) — 모든 기기에 동기화 브로드캐스트됨
  router.post('/danger', (req, res) => {
    const { danger } = req.body ?? {};
    if (typeof danger !== 'boolean') {
      return res.status(400).json({ error: 'danger(boolean)가 필요합니다' });
    }
    res.json({ danger: manager.setDanger(danger) });
  });

  // 세션 목록 (계정 격리: 내 세션 + 레거시/공유만)
  router.get('/sessions', (req, res) => {
    res.json({ sessions: manager.listFor(req.account) });
  });

  // 새 세션 생성
  router.post('/sessions', (req, res) => {
    const { cwd, title } = req.body ?? {};
    if (typeof cwd !== 'string' || !cwd.trim()) {
      return res.status(400).json({ error: 'cwd가 필요합니다' });
    }
    // 샌드박스: 이 계정의 루트 밖 폴더로는 세션을 못 연다.
    const root = req.account?.root ?? null;
    if (!isWithinRoot(root, cwd)) {
      return res.status(403).json({ error: '이 계정은 해당 폴더에 접근할 수 없습니다' });
    }
    // 세션에 루트(도구 경로 검사 기준)와 소유 계정(격리 기준)을 함께 실어 보낸다.
    const view = manager.create({ cwd, title, root, ownerId: req.account?.id ?? null });
    res.status(201).json({ session: view });
  });

  // 단일 세션 상세 (격리: 못 보는 세션은 404)
  router.get('/sessions/:id', (req, res) => {
    const view = manager.getFor(req.params.id, req.account);
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

    // 세션 cwd 를 알아야 파일을 저장할 수 있다 (존재 확인 겸, 격리 검사 포함)
    const view = manager.getFor(req.params.id, req.account);
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
    if (!manager.canAccess(req.params.id, req.account)) return res.status(404).json({ error: 'not found' });
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
    if (!manager.canAccess(req.params.id, req.account)) return res.status(404).json({ error: 'not found' });
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

  // 수동 컴팩션 (CPT 버튼) — 컨텍스트를 지금 압축해 토큰 재독 비용을 줄인다
  router.post('/sessions/:id/compact', (req, res) => {
    if (!manager.canAccess(req.params.id, req.account)) return res.status(404).json({ error: 'not found' });
    if (!manager.compact(req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  // 진행 중 턴 중단
  router.post('/sessions/:id/interrupt', async (req, res) => {
    if (!manager.canAccess(req.params.id, req.account)) return res.status(404).json({ error: 'not found' });
    if (!(await manager.interrupt(req.params.id))) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  // 세션 종료
  router.delete('/sessions/:id', (req, res) => {
    if (!manager.canAccess(req.params.id, req.account)) return res.status(404).json({ error: 'not found' });
    if (!manager.remove(req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true });
  });

  return router;
}
