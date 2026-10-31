import { Router, type Request, type Response } from 'express';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireToken } from './auth.js';
import { browse, browseFiles, defaultStartPath, isWithinRoot } from './browse.js';
import { CONVERTIBLE_EXT, findSoffice, toPdf } from './convert.js';
import { extractPptxVideos } from './pptxMedia.js';
import { auxStatus, startAux, stopAux, type AuxKind } from './auxServers.js';
import { saveUploads } from './uploads.js';
import { getFolderFreq } from './folderFreq.js';
import { serverStatus, memStatus, killProcess, appProcesses } from './servers.js';
import { findSupervisor, requestRestart, RESTART_DELAY_MS } from './restart.js';
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

/** statSync 가 throw 하지 않는 버전 (없으면 null) */
function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * ?path= 쿼리를 계정 루트 안의 '존재하는 파일' 절대경로로 해석한다.
 * 실패면 응답(400/403/404)을 이미 보내고 null — 파일 전송 라우트들의 공통 앞단.
 */
function fileInRoot(req: Request, res: Response): string | null {
  const p = typeof req.query.path === 'string' ? req.query.path : '';
  if (!p) {
    res.status(400).json({ error: 'path required' });
    return null;
  }
  const abs = resolve(p);
  if (!isWithinRoot(req.account?.root ?? null, abs)) {
    res.status(403).json({ error: 'outside root' });
    return null;
  }
  if (!statSafe(abs)?.isFile()) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return abs;
}

// 브라우저가 문서로 열면 스크립트가 도는 형식들. 같은 오리진으로 그대로 서빙하면
// 그 안의 스크립트가 localStorage 의 자격증명(아이디:비번)을 읽을 수 있다.
const ACTIVE_EXT = /\.(html?|xhtml|shtml|svgz?|xml|xsl|mht(ml)?)$/i;

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

  // 파일 탐색기 — 폴더+파일 목록 (계정 루트로 제한)
  router.get('/files', (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(browseFiles(path, req.account?.root ?? null));
  });

  // 파일 전송(브라우저 보기/재생/다운로드) — 계정 루트 안만. sendFile 이
  // MIME 판별과 Range(영상 탐색) 를 처리한다. ?download=1 이면 강제 다운로드.
  router.get('/file', (req, res) => {
    const abs = fileInRoot(req, res);
    if (!abs) return;
    if (req.query.download === '1') return res.download(abs);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // HTML/SVG 등은 sandbox CSP 로 고립(불투명 오리진 + 스크립트 금지) — 직접 링크로 열어도
    // 자격증명을 못 훔친다. <img src> 로 쓰는 SVG 미리보기는 영향 없다.
    if (ACTIVE_EXT.test(abs)) res.setHeader('Content-Security-Policy', 'sandbox');
    res.sendFile(abs);
  });

  // 오피스 문서 미리보기 — pptx/docx/xlsx 등을 LibreOffice 로 PDF 변환해 보낸다.
  // 캐시 적중이면 즉시, 아니면 수 초 소요. LibreOffice 미설치면 503 (뷰어가 안내 표시).
  router.get('/preview', async (req, res) => {
    const abs = fileInRoot(req, res);
    if (!abs) return;
    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
    if (!CONVERTIBLE_EXT.has(ext)) {
      return res.status(400).json({ error: '변환을 지원하지 않는 형식: ' + ext });
    }
    if (!findSoffice()) {
      return res.status(503).json({ error: 'LibreOffice가 설치되어 있지 않습니다' });
    }
    try {
      const pdf = await toPdf(abs);
      res.setHeader('Content-Type', 'application/pdf');
      // 캐시가 .data(닷폴더) 아래라 기본 dotfiles:'ignore' 면 404 가 난다 — 반드시 allow
      res.sendFile(pdf, { dotfiles: 'allow' });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // pptx 안의 영상 목록 — PDF 미리보기 아래에 재생 가능한 영상을 붙이기 위한 보조.
  // 응답: { videos: [{slide, name}] } (영상 없으면 빈 배열)
  router.get('/preview-media', async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) return res.status(400).json({ error: 'path required' });
    const abs = resolve(p);
    if (!isWithinRoot(req.account?.root ?? null, abs)) {
      return res.status(403).json({ error: 'outside root' });
    }
    if (!/\.pptx$/i.test(abs) || !statSafe(abs)?.isFile()) {
      return res.json({ videos: [] }); // pptx 외 형식/없는 파일은 조용히 빈 목록
    }
    try {
      res.json({ videos: (await extractPptxVideos(abs)).videos });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // pptx 추출 영상 파일 전송 — name 은 추출 캐시 폴더 안 파일명만 허용(경로 탈출 차단).
  // sendFile 이 Range(모바일 영상 탐색)를 처리한다.
  router.get('/preview-media/file', async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'bad name' });
    const abs = fileInRoot(req, res);
    if (!abs) return;
    try {
      const { dir } = await extractPptxVideos(abs); // 캐시 적중이면 manifest 읽기만
      const file = resolve(dir, name);
      if (!file.startsWith(resolve(dir)) || !statSafe(file)?.isFile()) {
        return res.status(404).json({ error: 'not found' });
      }
      res.sendFile(file, { dotfiles: 'allow' });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 위험 모드 조회
  router.get('/danger', (_req, res) => {
    res.json({ danger: manager.isDanger() });
  });

  // 보조 서버(정적/업로드) 상태 조회
  router.get('/aux', (_req, res) => {
    res.json({ aux: auxStatus() });
  });

  // ── 시스템 관리 라우트 가드 ──
  // 서버 현황/프로세스 목록/강제 종료/위험모드 전환은 PC 전체에 영향을 주므로
  // root 샌드박스 계정(동료용)에게는 금지 — 무제한 계정만 통과.
  const fullOnly: import('express').RequestHandler = (req, res, next) => {
    if (req.account?.root) return res.status(403).json({ error: 'forbidden (restricted account)' });
    next();
  };

  // 재시작 가능 여부만 미리 확인(버튼을 누르기 전 안내용). 종료는 하지 않는다.
  router.get('/restart', fullOnly, async (_req, res) => {
    res.json(await findSupervisor());
  });

  // 컨트롤러 서버 재시작. 서버가 스스로 되살아나는 게 아니라, 정상 종료하면
  // start-server.bat 의 :loop(cmd 창)가 3초 뒤 다시 띄우는 구조다 — 그래서 감시자가
  // 없으면 '죽기만 하고 안 살아나는' 상태가 되므로 409 로 거부한다. restart.ts 참고.
  router.post('/restart', fullOnly, async (_req, res) => {
    const sup = await findSupervisor();
    if (!sup.ok) return res.status(409).json({ error: sup.reason ?? '재시작할 수 없습니다' });
    if (!requestRestart('폰에서 재시작 요청')) {
      return res.status(500).json({ error: '종료 절차가 등록되지 않았습니다 (서버 기동 미완료)' });
    }
    // 응답을 먼저 보낸다 — 먼저 끊으면 폰은 성공을 네트워크 오류로 본다.
    res.json({ ok: true, via: sup.via, delayMs: RESTART_DELAY_MS });
  });

  // 로컬 서버 현황 — 이 PC 에서 LISTEN 중인 포트(알려진 고정 서버 + 기타)
  router.get('/servers', fullOnly, async (_req, res) => {
    try {
      res.json(await serverStatus());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // RAM 사용현황 — 시스템 전체 메모리 + 프로세스별 사용량 상위 목록.
  router.get('/processes', fullOnly, async (_req, res) => {
    try {
      res.json(await memStatus());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 앱별 프로세스 목록 — VS Code/Edge/Chrome 인스턴스를 묶어서(모든 인스턴스) 반환.
  router.get('/app-processes', fullOnly, async (_req, res) => {
    try {
      res.json(await appProcesses());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 선택 프로세스 종료 — 특정 PID 만. 서버 자신/OS 핵심 프로세스는 servers.ts 가드가 거부.
  // body: { pid: number }
  router.post('/kill', fullOnly, async (req, res) => {
    const pid = Number((req.body ?? {}).pid);
    if (!Number.isInteger(pid)) return res.status(400).json({ ok: false, reason: 'pid 필요' });
    try {
      res.json(await killProcess(pid));
    } catch (e) {
      res.status(500).json({ ok: false, pid, reason: e instanceof Error ? e.message : String(e) });
    }
  });

  // 보조 서버 열기/닫기 — 정적 파일 서버 또는 업로드 서버.
  // 전역 자원(LAN 포트)이고 stop 은 폴더 검사도 안 타므로 무제한 계정 전용.
  // body: { kind:'static'|'upload', action:'start'|'stop', dir?, port? }
  router.post('/aux', fullOnly, async (req, res) => {
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

  // 위험 모드 토글 (폰 ON/OFF 스위치) — 모든 기기에 동기화 브로드캐스트됨.
  // 전역(모든 세션 공통) 설정이므로 샌드박스 계정은 전환 불가.
  router.post('/danger', fullOnly, (req, res) => {
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

  // 응답 지연 진단 (진단 버튼) — 컨텍스트/모델시간/연결오류를 분석해 판정 + 권장 대응을 준다
  router.get('/sessions/:id/diagnose', (req, res) => {
    if (!manager.canAccess(req.params.id, req.account)) return res.status(404).json({ error: 'not found' });
    const diagnosis = manager.diagnose(req.params.id);
    if (!diagnosis) return res.status(404).json({ error: 'not found' });
    res.json({ diagnosis });
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
