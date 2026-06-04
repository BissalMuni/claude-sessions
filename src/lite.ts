import { Router } from 'express';
import { browse } from './browse.js';
import { TOKEN } from './auth.js';
import type { SessionManager } from './sessionManager.js';
import type { SessionView } from './types.js';

// 구닥다리 e-ink 브라우저용 lite UI.
// 규칙: JavaScript 0%, flexbox/grid 0%. 순수 HTML 폼 + <meta refresh> 폴링.
// 토큰은 모든 링크의 쿼리스트링과 모든 폼의 hidden input 으로 흘려보낸다.

const STATUS_KO: Record<string, string> = {
  starting: '시작중',
  idle: '대기',
  thinking: '작업중',
  awaiting_permission: '승인대기',
  awaiting_question: '질문대기',
  done: '완료',
  error: '오류',
};

export function createLiteRouter(manager: SessionManager): Router {
  const router = Router();

  // --- 토큰 확인: 없거나 틀리면 로그인 페이지 ---
  function tokenOf(req: any): string | null {
    const t = req.query?.token ?? req.body?.token;
    return typeof t === 'string' ? t : null;
  }
  function authed(req: any): boolean {
    return tokenOf(req) === TOKEN;
  }

  // 로그인 페이지
  router.get('/', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    res.send(dashboardPage(manager.list(), TOKEN));
  });

  // 세션 상세
  router.get('/session', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const view = manager.get(String(req.query.id || ''));
    if (!view) return res.send(notFoundPage(TOKEN));
    res.send(detailPage(view, TOKEN));
  });

  // 폴더 피커 (새 세션)
  router.get('/new', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    res.send(pickerPage(browse(path), TOKEN));
  });

  // --- 액션 (POST 폼) ---

  router.post('/create', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const cwd = String(req.body.cwd || '').trim();
    const title = String(req.body.title || '').trim();
    if (!cwd) return res.send(messagePage('작업 폴더가 없습니다.', TOKEN));
    const view = manager.create({ cwd, title });
    res.redirect(liteUrl('/lite/session', { token: TOKEN, id: view.id }));
  });

  router.post('/prompt', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const id = String(req.body.id || '');
    const text = String(req.body.text || '').trim();
    if (text) manager.sendPrompt(id, text);
    res.redirect(liteUrl('/lite/session', { token: TOKEN, id }));
  });

  router.post('/approve', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const id = String(req.body.id || '');
    const requestId = String(req.body.requestId || '');
    const decision = req.body.decision === 'yes' ? 'yes' : 'no';
    manager.approve(requestId, decision);
    // 승인은 대시보드에서도 자주 누르므로, 온 곳(back)으로 돌려보낸다
    const back = String(req.body.back || '');
    res.redirect(back === 'dashboard' ? liteUrl('/lite', { token: TOKEN }) : liteUrl('/lite/session', { token: TOKEN, id }));
  });

  router.post('/answer', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const id = String(req.body.id || '');
    const requestId = String(req.body.requestId || '');
    const view = manager.get(id);
    const questions = view?.question?.questions ?? [];
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const sel = req.body['a' + qi];
      const picked = Array.isArray(sel)
        ? sel.map(String)
        : sel != null && sel !== ''
          ? [String(sel)]
          : [];
      const other = String(req.body['o' + qi] || '').trim();
      const vals = other ? [...picked, other] : picked;
      answers[q.question] = vals.join(', ');
    });
    manager.answer(requestId, answers);
    res.redirect(liteUrl('/lite/session', { token: TOKEN, id }));
  });

  router.post('/interrupt', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    const id = String(req.body.id || '');
    void manager.interrupt(id);
    res.redirect(liteUrl('/lite/session', { token: TOKEN, id }));
  });

  router.post('/remove', (req, res) => {
    if (!authed(req)) return res.send(loginPage());
    manager.remove(String(req.body.id || ''));
    res.redirect(liteUrl('/lite', { token: TOKEN }));
  });

  return router;
}

// ---------- HTML 빌더 (옛 브라우저 호환) ----------

function page(title: string, body: string, opts?: { refresh?: number }): string {
  const refresh = opts?.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  // 인라인 CSS, flexbox/grid 없이 블록·테이블만. 고대비(흑/백) + 큰 글씨.
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>${esc(title)}</title>
<style>
body{background:#fff;color:#000;font-family:sans-serif;font-size:18px;line-height:1.5;margin:0;padding:12px;}
a{color:#000;}
h1{font-size:22px;margin:6px 0 12px;}
h2{font-size:19px;margin:14px 0 6px;}
.bar{border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px;}
.btn{display:inline-block;border:2px solid #000;background:#fff;color:#000;padding:8px 14px;margin:2px 4px 2px 0;text-decoration:none;font-size:18px;}
.btn-big{padding:14px 18px;font-size:20px;font-weight:bold;}
.row{border:2px solid #000;padding:10px;margin-bottom:10px;}
.muted{color:#444;font-size:15px;}
.tag{border:1px solid #000;padding:1px 8px;font-size:14px;}
.tag-await{background:#000;color:#fff;}
.cmd{font-family:monospace;font-size:16px;border:1px dashed #000;padding:6px;margin:6px 0;word-break:break-all;white-space:pre-wrap;}
.msg{border-bottom:1px solid #ccc;padding:6px 0;white-space:pre-wrap;word-break:break-word;}
.who{font-size:13px;color:#555;}
input[type=text],textarea{width:100%;font-size:18px;padding:8px;border:2px solid #000;box-sizing:border-box;}
textarea{height:80px;}
form{margin:0;}
.inline{display:inline;}
hr{border:none;border-top:1px solid #ccc;margin:12px 0;}
</style>
</head><body>${body}</body></html>`;
}

function loginPage(): string {
  return page(
    'claude-sessions',
    `<div class="bar"><h1>claude-sessions</h1></div>
<p>접속 토큰을 입력하세요.</p>
<form method="get" action="/lite">
  <input type="text" name="token" placeholder="토큰" autocomplete="off">
  <p><button class="btn btn-big" type="submit">접속</button></p>
</form>`,
  );
}

function dashboardPage(sessions: SessionView[], token: string): string {
  const sorted = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rows = sorted.length
    ? sorted.map((s) => dashboardRow(s, token)).join('')
    : '<p class="muted">아직 세션이 없습니다.</p>';
  const body = `<div class="bar">
  <h1>세션 (${sorted.length})</h1>
  <a class="btn" href="${liteUrl('/lite/new', { token })}">+ 새 세션</a>
  <a class="btn" href="${liteUrl('/lite', { token })}">↻ 새로고침</a>
</div>
${rows}
<p class="muted">이 화면은 5초마다 자동 새로고침됩니다.</p>`;
  return page('세션 목록', body, { refresh: 5 });
}

function dashboardRow(s: SessionView, token: string): string {
  const awaiting = s.status === 'awaiting_permission' || s.status === 'awaiting_question';
  const tag = `<span class="tag ${awaiting ? 'tag-await' : ''}">${STATUS_KO[s.status] || s.status}</span>`;
  let perm = '';
  if (s.pending) {
    // 대시보드에서 바로 승인/거부 (돌아가며 단계 파악 → 즉시 승인)
    perm = `<div class="cmd">${esc(s.pending.summary)}</div>
${approveForm(s.id, s.pending.requestId, token, 'dashboard')}`;
  }
  return `<div class="row">
  <b><a href="${liteUrl('/lite/session', { token, id: s.id })}">${esc(s.title)}</a></b> ${tag}
  <div class="muted">${esc(s.cwd)}</div>
  ${perm}
</div>`;
}

function detailPage(s: SessionView, token: string): string {
  const msgs = s.messages.slice(-40);
  const log = msgs.length
    ? msgs
        .map(
          (m) =>
            `<div class="msg"><span class="who">${esc(whoLabel(m.kind))}</span><br>${esc(m.text)}</div>`,
        )
        .join('')
    : '<p class="muted">(아직 메시지 없음)</p>';

  const perm = s.pending
    ? `<h2>승인 필요</h2>
<div class="row">
  <div>${esc(s.pending.title || s.pending.toolName + ' 실행을 허가할까요?')}</div>
  <div class="cmd">${esc(s.pending.summary)}</div>
  ${approveForm(s.id, s.pending.requestId, token, 'detail')}
</div>`
    : '';

  const question = s.question ? questionForm(s, token) : '';

  const body = `<div class="bar">
  <h1>${esc(s.title)} <span class="tag">${STATUS_KO[s.status] || s.status}</span></h1>
  <a class="btn" href="${liteUrl('/lite/session', { token, id: s.id })}">↻ 새로고침</a>
  <a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>
</div>
<div class="muted">${esc(s.cwd)}</div>
${perm}
${question}
<h2>대화</h2>
${log}
<hr>
<h2>명령 보내기</h2>
<form method="post" action="/lite/prompt">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(s.id)}">
  <textarea name="text" placeholder="다음 명령을 입력…"></textarea>
  <p><button class="btn btn-big" type="submit">전송</button></p>
</form>
<hr>
<form method="post" action="/lite/interrupt" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(s.id)}">
  <button class="btn" type="submit">진행 중단</button>
</form>
<form method="post" action="/lite/remove" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(s.id)}">
  <button class="btn" type="submit">세션 종료</button>
</form>`;
  return page(s.title, body);
}

function pickerPage(b: ReturnType<typeof browse>, token: string): string {
  const up =
    b.parent !== null
      ? `<a class="btn" href="${liteUrl('/lite/new', { token, path: b.parent })}">⬆ 상위로</a>`
      : '';
  const drivesOrDirs = b.dirs.length
    ? b.dirs
        .map(
          (d) =>
            `<div class="row"><a href="${liteUrl('/lite/new', { token, path: d })}">📁 ${esc(d)}</a></div>`,
        )
        .join('')
    : '<p class="muted">하위 폴더가 없습니다.</p>';

  const err = b.error ? `<p class="muted">열 수 없음: ${esc(b.error)}</p>` : '';
  const here = b.isRoot ? '(드라이브 선택)' : esc(b.path);

  // 현재 폴더로 세션 생성 (드라이브 목록 화면이 아닐 때만)
  const createForm = b.isRoot
    ? ''
    : `<h2>이 폴더로 세션 만들기</h2>
<div class="cmd">${esc(b.path)}</div>
<form method="post" action="/lite/create">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="cwd" value="${esc(b.path)}">
  <p class="muted">제목(선택, 비우면 폴더명)</p>
  <input type="text" name="title" autocomplete="off">
  <p><button class="btn btn-big" type="submit">이 폴더로 생성</button></p>
</form>
<hr>`;

  const body = `<div class="bar">
  <h1>폴더 선택</h1>
  <a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>
</div>
<p class="muted">현재: ${here}</p>
${up}
${createForm}
<h2>하위 폴더</h2>
${err}
${drivesOrDirs}`;
  return page('폴더 선택', body);
}

function approveForm(id: string, requestId: string, token: string, back: string): string {
  // Yes / No 를 각각 별도 POST 폼으로 (JS 없이 동작)
  return `<form method="post" action="/lite/approve" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(id)}">
  <input type="hidden" name="requestId" value="${esc(requestId)}">
  <input type="hidden" name="back" value="${esc(back)}">
  <input type="hidden" name="decision" value="yes">
  <button class="btn btn-big" type="submit">✔ 허가</button>
</form>
<form method="post" action="/lite/approve" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(id)}">
  <input type="hidden" name="requestId" value="${esc(requestId)}">
  <input type="hidden" name="back" value="${esc(back)}">
  <input type="hidden" name="decision" value="no">
  <button class="btn btn-big" type="submit">✘ 거부</button>
</form>`;
}

function questionForm(s: SessionView, token: string): string {
  const q = s.question!;
  const blocks = q.questions
    .map((qq, qi) => {
      const type = qq.multiSelect ? 'checkbox' : 'radio';
      const opts = qq.options
        .map(
          (o) =>
            `<div><label><input type="${type}" name="a${qi}" value="${esc(o.label)}"> <b>${esc(o.label)}</b>${o.description ? ` — <span class="muted">${esc(o.description)}</span>` : ''}</label></div>`,
        )
        .join('');
      return `<div class="row">
  ${qq.header ? `<div><span class="tag">${esc(qq.header)}</span></div>` : ''}
  <div><b>${esc(qq.question)}</b></div>
  ${opts}
  <p class="muted">기타(직접 입력)</p>
  <input type="text" name="o${qi}" autocomplete="off">
</div>`;
    })
    .join('');
  return `<h2>질문에 답하기</h2>
<form method="post" action="/lite/answer">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(s.id)}">
  <input type="hidden" name="requestId" value="${esc(q.requestId)}">
  ${blocks}
  <p><button class="btn btn-big" type="submit">선택 전송</button></p>
</form>`;
}

function notFoundPage(token: string): string {
  return page('없음', `<p>세션을 찾을 수 없습니다.</p><a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>`);
}
function messagePage(msg: string, token: string): string {
  return page('알림', `<p>${esc(msg)}</p><a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>`);
}

// ---------- 유틸 ----------

function liteUrl(path: string, params: Record<string, string>): string {
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${path}?${q}`;
}

function whoLabel(kind: string): string {
  return (
    {
      text: 'Claude',
      tool: '도구',
      result: '결과',
      system: '시스템',
      user: '나',
      error: '오류',
    } as Record<string, string>
  )[kind] || kind;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
