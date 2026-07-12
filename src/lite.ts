import { Router } from 'express';
import { browse, defaultStartPath } from './browse.js';
import { accountForToken, type Account } from './auth.js';
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

// 중요도(스티커) 우선순위: 내 조치가 필요한 세션일수록 위로 올라온다.
const STATUS_RANK: Record<string, number> = {
  awaiting_permission: 0, // 승인대기 — 나를 기다림
  awaiting_question: 1, // 질문대기 — 나를 기다림
  error: 2, // 오류
  done: 3, // 완료(답변 떴다)
  idle: 4, // 대기(내 턴)
  thinking: 5, // 작업중 — 조치 불필요
  starting: 6, // 시작중
};
// 정렬: 상태 중요도 → 정체 의심(위로) → 생성순.
function byImportance(a: SessionView, b: SessionView): number {
  const ra = STATUS_RANK[a.status] ?? 99;
  const rb = STATUS_RANK[b.status] ?? 99;
  if (ra !== rb) return ra - rb;
  if (!!a.stalled !== !!b.stalled) return a.stalled ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

export function createLiteRouter(manager: SessionManager): Router {
  const router = Router();

  // --- 접근 확인 ---
  // lite 는 full-access(root=null) 계정만 쓸 수 있다. 샌드박스(루트 제한) 계정은
  // lite 가 폴더 제한을 강제하지 않으므로 아예 차단한다(SPA 를 쓰도록 안내).
  function tokenOf(req: any): string | null {
    const t = req.query?.token ?? req.body?.token;
    return typeof t === 'string' ? t : null;
  }
  // 통과하면 { token, account } 반환, 아니면 보여줄 페이지({ page }) 반환.
  function gate(req: any): { token: string; account: Account } | { page: string } {
    const t = tokenOf(req);
    const acc = accountForToken(t);
    if (!acc) return { page: loginPage() };
    if (acc.root !== null) return { page: restrictedPage() };
    return { token: acc.token, account: acc };
  }

  // 로그인/대시보드
  router.get('/', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    res.send(dashboardPage(manager.listFor(g.account), g.token, manager.isDanger()));
  });

  // 세션 상세
  router.get('/session', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.query.id || '');
    const view = manager.getFor(id, g.account);
    if (!view) return res.send(notFoundPage(g.token));
    // 대시보드와 같은 중요도순으로 정렬해 '다음' 세션(프로젝트) id 를 계산.
    // 맨 끝에서는 처음으로 순환(wrap-around) → '다음'은 항상 다음 프로젝트 상세로 바로 연결된다.
    const ordered = [...manager.listFor(g.account)].sort(byImportance);
    const idx = ordered.findIndex((x) => x.id === id);
    const nextId = idx >= 0 && ordered.length > 1 ? ordered[(idx + 1) % ordered.length].id : null;
    res.send(detailPage(view, g.token, nextId, manager.isDanger()));
  });

  // 폴더 피커 (새 세션) — full-access 계정만 오므로 무제한 탐색
  router.get('/new', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    // 쿼리에 path 가 있으면 그걸로(빈 문자열='상위로 → 드라이브 목록'도 존중), 없으면 기본 시작 폴더
    const path = typeof req.query.path === 'string' ? req.query.path : defaultStartPath();
    res.send(pickerPage(browse(path), g.token));
  });

  // --- 액션 (POST 폼) ---

  router.post('/create', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const cwd = String(req.body.cwd || '').trim();
    const title = String(req.body.title || '').trim();
    if (!cwd) return res.send(messagePage('작업 폴더가 없습니다.', g.token));
    const view = manager.create({ cwd, title, ownerId: g.account.id });
    res.redirect(liteUrl('/lite/session', { token: g.token, id: view.id }));
  });

  router.post('/prompt', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.body.id || '');
    if (!manager.canAccess(id, g.account)) return res.send(notFoundPage(g.token));
    const text = String(req.body.text || '').trim();
    if (text) manager.sendPrompt(id, text);
    res.redirect(liteUrl('/lite/session', { token: g.token, id }));
  });

  router.post('/approve', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.body.id || '');
    if (!manager.canAccess(id, g.account)) return res.send(notFoundPage(g.token));
    const requestId = String(req.body.requestId || '');
    const decision = req.body.decision === 'yes' ? 'yes' : 'no';
    manager.approve(requestId, decision);
    // 승인은 대시보드에서도 자주 누르므로, 온 곳(back)으로 돌려보낸다
    const back = String(req.body.back || '');
    res.redirect(back === 'dashboard' ? liteUrl('/lite', { token: g.token }) : liteUrl('/lite/session', { token: g.token, id }));
  });

  router.post('/answer', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.body.id || '');
    if (!manager.canAccess(id, g.account)) return res.send(notFoundPage(g.token));
    const requestId = String(req.body.requestId || '');
    const view = manager.getFor(id, g.account);
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
    res.redirect(liteUrl('/lite/session', { token: g.token, id }));
  });

  router.post('/interrupt', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.body.id || '');
    if (!manager.canAccess(id, g.account)) return res.send(notFoundPage(g.token));
    void manager.interrupt(id);
    res.redirect(liteUrl('/lite/session', { token: g.token, id }));
  });

  // 수동 컴팩션 (CPT) — 이 세션 컨텍스트를 지금 압축해 토큰 재독 비용을 줄인다
  router.post('/compact', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.body.id || '');
    if (!manager.canAccess(id, g.account)) return res.send(notFoundPage(g.token));
    manager.compact(id);
    res.redirect(liteUrl('/lite/session', { token: g.token, id }));
  });

  router.post('/remove', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const id = String(req.body.id || '');
    if (!manager.canAccess(id, g.account)) return res.send(notFoundPage(g.token));
    manager.remove(id);
    res.redirect(liteUrl('/lite', { token: g.token }));
  });

  // 위험 모드 토글 (JS 없는 폼). 켜기는 자동 실행을 여는 동작이라 확인 페이지를 한 번 거친다.
  // 끄기(안전 방향)는 즉시 적용. 토글하면 SPA 등 모든 기기에 danger 이벤트가 브로드캐스트된다.
  router.post('/danger', (req, res) => {
    const g = gate(req);
    if ('page' in g) return res.send(g.page);
    const to = req.body.to === 'on' ? 'on' : 'off';
    const back = String(req.body.back || ''); // 'dashboard' 또는 세션 id
    if (to === 'on' && req.body.confirm !== '1') {
      return res.send(dangerConfirmPage(g.token, back));
    }
    manager.setDanger(to === 'on');
    res.redirect(liteBackUrl(back, g.token));
  });

  return router;
}

// ---------- HTML 빌더 (옛 브라우저 호환) ----------

function page(
  title: string,
  body: string,
  opts?: { refresh?: number; scrollBottom?: boolean },
): string {
  const refresh = opts?.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  // 로드되면 곧바로 화면 하단(최근 메시지 + 입력창)이 보이도록 스크롤
  const scrollScript = opts?.scrollBottom
    ? `<script>function _b(){window.scrollTo(0,document.body.scrollHeight);}window.onload=_b;setTimeout(_b,0);setTimeout(_b,200);</script>`
    : '';
  // 인라인 CSS, flexbox/grid 없이 블록·테이블만. 고대비(흑/백) + 큰 글씨.
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>${esc(title)}</title>
<style>
body{background:#fff;color:#000;font-family:sans-serif;font-size:27px;line-height:1.5;margin:0;padding:12px;}
a{color:#000;}
h1{font-size:33px;margin:6px 0 12px;}
h2{font-size:29px;margin:14px 0 6px;}
.bar{border-bottom:2px solid #000;padding:8px 0;margin:0 0 12px;position:sticky;top:0;background:#fff;z-index:5;}
.dock{position:sticky;bottom:0;background:#fff;border-top:2px solid #000;padding:8px 0 4px;margin-top:12px;z-index:5;}
.dock textarea{height:60px;}
.dock h2{margin:0 0 6px;}
.dock-title{font-weight:bold;font-size:24px;margin:0 0 6px;}
.btn{display:inline-block;-webkit-appearance:none;appearance:none;border:2px solid #000;border-radius:0;background:#fff;color:#000;padding:8px 14px;margin:2px 4px 2px 0;text-decoration:none;font-size:27px;font-family:inherit;line-height:1.2;vertical-align:middle;cursor:pointer;}
.btn-big{padding:14px 18px;font-size:30px;font-weight:bold;}
.ctrls{line-height:1.9;}
.ctrls .btn{margin:0 6px 6px 0;vertical-align:middle;}
.ctrls form{display:inline;margin:0;}
/* 구형 e-ink 브라우저용: flexbox 없이 table 한 행으로 버튼을 한 줄에 강제 배치.
   박스(테두리)는 <td>가 그리므로 <a>/<button> 구분 없이 동일하게 보인다. */
.btnrow{width:100%;border-collapse:collapse;table-layout:fixed;margin:4px 0;}
.btnrow td{border:2px solid #000;padding:0;text-align:center;}
.btnrow td form{display:block;margin:0;}
.btnrow td .btn{display:block;width:100%;box-sizing:border-box;margin:0;border:0;border-radius:0;background:#fff;color:#000;padding:14px 4px;font-size:27px;line-height:1.2;white-space:nowrap;overflow:hidden;}
.row{border:2px solid #000;padding:10px;margin-bottom:10px;}
.danger-on{border-width:4px;}
.muted{color:#444;font-size:23px;}
.tag{border:1px solid #000;padding:1px 8px;font-size:21px;}
.tag-await{background:#000;color:#fff;}
.tag-work{border:2px solid #000;font-weight:bold;}
.cmd{font-family:monospace;font-size:24px;border:1px dashed #000;padding:6px;margin:6px 0;word-break:break-all;white-space:pre-wrap;}
.msg{border-bottom:1px solid #ccc;padding:6px 0;white-space:pre-wrap;word-break:break-word;}
.who{font-size:20px;color:#555;}
input[type=text],textarea{width:100%;font-size:27px;padding:8px;border:2px solid #000;box-sizing:border-box;}
textarea{height:80px;}
form{margin:0;}
.inline{display:inline;}
hr{border:none;border-top:1px solid #ccc;margin:12px 0;}
</style>
</head><body>${body}${scrollScript}</body></html>`;
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

// 샌드박스(루트 제한) 계정이 lite 로 들어오면 보여줄 차단 페이지.
// lite 는 폴더 제한을 강제하지 않으므로 접근을 막고 기본 UI 로 안내한다.
function restrictedPage(): string {
  return page(
    'claude-sessions',
    `<div class="bar"><h1>claude-sessions</h1></div>
<p>이 계정은 폴더 접근이 제한되어 있어 lite 화면을 쓸 수 없습니다.</p>
<p>기본 화면( / )으로 접속하세요.</p>
<form method="get" action="/lite">
  <input type="text" name="token" placeholder="다른 토큰" autocomplete="off">
  <p><button class="btn btn-big" type="submit">다시 접속</button></p>
</form>`,
  );
}

function dashboardPage(sessions: SessionView[], token: string, danger: boolean): string {
  const sorted = [...sessions].sort(byImportance);
  const rows = sorted.length
    ? sorted.map((s) => dashboardRow(s, token)).join('')
    : '<p class="muted">아직 세션이 없습니다.</p>';
  const body = `<div class="bar">
  <h1>세션 (${sorted.length})</h1>
</div>
${dangerBar(token, danger, 'dashboard')}
${rows}
<p class="muted">이 화면은 15초마다 자동 새로고침됩니다.</p>
<div class="dock">
  <p class="ctrls">
    <a class="btn" href="${liteUrl('/lite', { token })}">↻ 새로고침</a>
    <a class="btn btn-big" href="${liteUrl('/lite/new', { token })}">+ 새 세션</a>
  </p>
</div>`;
  return page('세션 목록', body, { refresh: 15 });
}

function dashboardRow(s: SessionView, token: string): string {
  const awaiting = s.status === 'awaiting_permission' || s.status === 'awaiting_question';
  const working = s.status === 'thinking';
  const tagClass = awaiting ? 'tag-await' : working ? 'tag-work' : '';
  const base = working ? '⏳ 클로드 응답 대기중' : STATUS_KO[s.status] || s.status;
  const label = s.stalled ? base + ' ⚠정체?' : base;
  const tag = `<span class="tag ${tagClass}">${label}</span>`;
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

function detailPage(s: SessionView, token: string, nextId: string | null | undefined, danger: boolean): string {
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
  <p class="ctrls">
    <a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>
    <a class="btn" href="${liteUrl('/lite/session', { token, id: s.id })}">↻ 새로고침</a>
    ${compactForm(token, s.id)}
    ${dangerToggle(token, danger, s.id)}
  </p>
</div>
<div class="muted">${esc(s.cwd)}</div>
<h2>대화</h2>
${log}
<div class="dock">
  ${btnRow([
    `<button class="btn" type="submit" form="promptForm">전송</button>`,
    `<a class="btn" href="${liteUrl('/lite/session', { token, id: s.id })}">↻ 새로고침</a>`,
    `<a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>`,
    `<form method="post" action="/lite/interrupt"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="id" value="${esc(s.id)}"><button class="btn" type="submit">중단</button></form>`,
    `<form method="post" action="/lite/remove"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="id" value="${esc(s.id)}"><button class="btn" type="submit">종료</button></form>`,
    // 종료 다음: 다음 세션(프로젝트)으로 이동. 다음이 없으면 목록으로 돌아간다.
    nextId
      ? `<a class="btn" href="${liteUrl('/lite/session', { token, id: nextId })}">다음 ▶</a>`
      : `<a class="btn" href="${liteUrl('/lite', { token })}">다음 ▶</a>`,
  ])}
  <div class="dock-title">${esc(s.title)} <span class="tag">${STATUS_KO[s.status] || s.status}</span></div>
  ${perm}
  ${question}
  <form id="promptForm" method="post" action="/lite/prompt">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="id" value="${esc(s.id)}">
    <textarea name="text" placeholder="다음 명령을 입력…"></textarea>
  </form>
</div>`;
  return page(s.title, body, { scrollBottom: true });
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
</div>
<p class="muted">현재: ${here}</p>
${createForm}
<h2>하위 폴더</h2>
${err}
${drivesOrDirs}
<div class="dock">
  <p class="ctrls">
    ${up}
    <a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>
  </p>
</div>`;
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

// 위험 모드 배너 (대시보드용, 큼직하게). 현재 상태 + 반대로 가는 토글 버튼 1개.
function dangerBar(token: string, danger: boolean, back: string): string {
  if (danger) {
    return `<div class="row danger-on">
  <b>⚠ 위험 모드 ON</b> <span class="muted">모든 도구 자동 실행 · AskUserQuestion만 폰 질문</span>
  ${btnRow([dangerForm(token, 'off', back, '🔒 안전 모드로 끄기')])}
</div>`;
  }
  return `<div class="row">
  <b>🔒 안전 모드</b> <span class="muted">모든 도구가 폰 승인(허가/거부)을 거침</span>
  ${btnRow([dangerForm(token, 'on', back, '⚠ 위험 모드 켜기')])}
</div>`;
}

// 위험 모드 컴팩트 토글 (상세 상단 바용). 현재 상태가 라벨에 드러난다.
function dangerToggle(token: string, danger: boolean, back: string): string {
  return danger
    ? dangerForm(token, 'off', back, '⚠ 위험 ON (끄기)')
    : dangerForm(token, 'on', back, '🔒 안전 (위험 켜기)');
}

// 수동 컴팩션(CPT) 폼 1개. 누르면 즉시 /compact 를 세션에 주입해 컨텍스트를 압축한다.
function compactForm(token: string, id: string): string {
  return `<form method="post" action="/lite/compact" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="id" value="${esc(id)}">
  <button class="btn" type="submit" title="컨텍스트 압축">🗜 압축</button>
</form>`;
}

// 위험 모드 토글 폼 1개. to='on' 이면 서버가 확인 페이지를 한 번 띄운다(JS confirm 대체).
function dangerForm(token: string, to: 'on' | 'off', back: string, label: string): string {
  return `<form method="post" action="/lite/danger" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="to" value="${to}">
  <input type="hidden" name="back" value="${esc(back)}">
  <button class="btn" type="submit">${esc(label)}</button>
</form>`;
}

// 위험 모드 켜기 확인 페이지 (JS 없는 환경에서 실수 방지용 한 단계).
function dangerConfirmPage(token: string, back: string): string {
  return page(
    '위험 모드 켜기',
    `<div class="bar"><h1>⚠ 위험 모드 켜기</h1></div>
<p>모든 도구가 폰 승인 없이 <b>자동 실행</b>됩니다.<br>
AskUserQuestion(방향 결정)만 폰으로 질문합니다.<br>정말 켤까요?</p>
<form method="post" action="/lite/danger">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="to" value="on">
  <input type="hidden" name="confirm" value="1">
  <input type="hidden" name="back" value="${esc(back)}">
  <p><button class="btn btn-big" type="submit">⚠ 켭니다</button></p>
</form>
<p><a class="btn" href="${liteBackUrl(back, token)}">취소</a></p>`,
  );
}

// back('dashboard' 또는 세션 id)을 돌아갈 URL 로 바꾼다.
function liteBackUrl(back: string, token: string): string {
  return back && back !== 'dashboard'
    ? liteUrl('/lite/session', { token, id: back })
    : liteUrl('/lite', { token });
}

function notFoundPage(token: string): string {
  return page('없음', `<p>세션을 찾을 수 없습니다.</p><a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>`);
}
function messagePage(msg: string, token: string): string {
  return page('알림', `<p>${esc(msg)}</p><a class="btn" href="${liteUrl('/lite', { token })}">◀ 목록</a>`);
}

// ---------- 유틸 ----------

// 버튼들을 table 한 행으로 묶어 구형 브라우저에서도 무조건 한 줄에 배치한다.
// (각 셀이 테두리를 그리므로 <a>/<button> 구분 없이 동일한 박스로 보인다)
function btnRow(cells: string[]): string {
  return `<table class="btnrow"><tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr></table>`;
}

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
