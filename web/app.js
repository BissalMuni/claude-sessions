// 폰 클라이언트 — 토큰 인증, WebSocket 수신, 세션 목록/상세/승인/명령

const $ = (id) => document.getElementById(id);

// 모바일(터치 위주) 여부 — 데스크톱은 엔터 전송, 모바일은 Ctrl/Cmd+엔터 전송
const isMobile = () => window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const state = {
  token: localStorage.getItem('sm_token') || '',
  sessions: new Map(), // id -> SessionView
  selected: null, // 선택된 세션 id
  ws: null,
  drafts: new Map(), // sessionId -> 입력 중인(아직 전송 안 한) 텍스트
  images: new Map(), // sessionId -> [{ name, mediaType, data }] 첨부 대기 이미지(인라인)
  files: new Map(), // sessionId -> [{ name, mediaType, data, size }] 첨부 대기 파일(디스크 저장)
  pollTimer: null, // WS 푸시 유실 대비 폴링 안전망
  notified: [], // 답변이 뜬(알림) 세션 id 큐 — 선입선출(먼저 등록된 게 먼저 나감)
  prevStatus: new Map(), // id -> 직전 상태(작업중→대기 전환을 새 알림으로 감지)
  noticeFlashUntil: 0, // 이 시각(ms)까지 종 버튼 깜빡임 효과 유지 (새 알림 후 2초)
  flashTimer: null, // 깜빡임 종료 시 화면을 한 번 더 그려 효과를 끄는 타이머
  pickerSelected: new Set(), // 새 세션 모달에서 다중 선택한 폴더 경로(한 번에 여러 세션 생성)
  danger: true, // 위험 모드(모든 도구 자동 실행). 서버 snapshot/danger 이벤트로 동기화. 기본 ON.
  aux: { static: { running: false }, upload: { running: false } }, // 보조 서버 상태(서버 동기화)
  pickerPick: null, // 폴더 피커가 '단일 폴더 선택' 모드일 때의 콜백(있으면 세션 생성 대신 이 콜백 호출)
  serversTimer: null, // 서버 현황 페이지를 보는 동안의 자동 새로고침 타이머
};

// 목록 맨 위 고정 항목: 세션이 아니라 "서버 현황" 특수 페이지를 가리키는 센티넬 id.
const SERVERS_ID = '__servers__';

// ---------- 폴더 사용 빈도 (자주 여는 프로젝트를 위로) ----------
// 빈도는 이제 서버(.data/folder-freq.json)에 모아 모든 기기가 공유한다.
// 세션을 만들면 서버가 자동으로 +1 하므로, 클라이언트는 읽기만 한다.
let folderFreq = {}; // 경로 -> 사용 횟수 (피커 열 때 서버에서 채움)
async function refreshFreq() {
  try { const d = await api('GET', '/folder-freq'); folderFreq = d.freq || {}; }
  catch { /* 실패해도 피커는 동작: 빈 빈도로 이름순 정렬 */ }
}

// 작업중 → 대기 전환 = "답변이 떴다". 직전 상태와 비교해 새 알림만 잡아낸다.
const WAITING_STATES = new Set(['idle', 'done', 'awaiting_permission', 'awaiting_question', 'error']);
function answered(s) {
  const prev = state.prevStatus.get(s.id);
  state.prevStatus.set(s.id, s.status);
  if (prev === undefined || prev === s.status) return false; // 첫 등장/변화 없음 → 기준만 갱신
  return WAITING_STATES.has(s.status) && !WAITING_STATES.has(prev);
}
// 알림 큐(FIFO): 보고 있는 세션은 제외, 중복은 순서 보존 위해 무시
function enqueueNotice(id) {
  if (id === state.selected) return;
  if (state.notified.includes(id)) return;
  state.notified.push(id);
  // 새 알림 → 지금부터 2초간 깜빡임 효과, 2초 뒤 다시 렌더해서 효과를 끈다
  state.noticeFlashUntil = Date.now() + 2000;
  if (state.flashTimer) clearTimeout(state.flashTimer);
  state.flashTimer = setTimeout(() => { state.flashTimer = null; render(); }, 2050);
}
function clearNotice(id) {
  const i = state.notified.indexOf(id);
  if (i >= 0) state.notified.splice(i, 1);
}
// 세션 선택 = 그 세션의 알림 해제 + 기준 상태 갱신 후 렌더
function selectSession(id) {
  state.selected = id;
  clearNotice(id);
  if (id != null) { const s = state.sessions.get(id); if (s) state.prevStatus.set(id, s.status); }
  render();
}

// ---------- 인증 ----------
function showGate(msg) {
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('gate-err').textContent = msg || '';
}
function enterApp() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  connect();
  startPolling();
}

// WebSocket 푸시가 유실돼도(반쯤 끊긴 소켓 등) 화면이 멈추지 않도록,
// 주기적으로 전체 상태를 가져와 병합한다. lite 의 meta-refresh 와 같은 안전망.
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollSessions, 7000);
}
// 세션 상태의 변화 지문(updatedAt 등). 같으면 다시 그릴 필요가 없다.
function sessionsSig(list) {
  return list
    .map((s) => `${s.id}:${s.updatedAt}:${s.stalled ? 1 : 0}:${s.pending ? s.pending.requestId : ''}:${s.question ? s.question.requestId : ''}`)
    .sort()
    .join('|');
}
async function pollSessions() {
  if (!state.token) return;
  try {
    const data = await api('GET', '/sessions');
    const before = sessionsSig([...state.sessions.values()]);
    const ids = new Set();
    for (const s of data.sessions) { state.sessions.set(s.id, s); ids.add(s.id); if (answered(s)) enqueueNotice(s.id); }
    for (const id of [...state.sessions.keys()]) if (!ids.has(id)) state.sessions.delete(id);
    // 변화가 있을 때만 다시 그린다 — 가만히 읽고 있을 땐 화면이 흔들리지 않음
    if (sessionsSig([...state.sessions.values()]) !== before) render();
  } catch {
    /* 폴링 실패는 조용히 무시 — WS 가 주 채널, 다음 주기에 재시도 */
  }
}
$('token-btn').onclick = () => {
  const t = $('token-input').value.trim();
  if (!t) return;
  state.token = t;
  localStorage.setItem('sm_token', t);
  enterApp();
};
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-btn').click(); });
$('list-btn').onclick = () => selectSession(null); // 상단바: 목록으로 복귀

// 로그아웃: 저장된 토큰을 지우고 연결을 끊은 뒤 로그인 화면으로.
// (다계정 — 다른 비번으로 다시 접속할 때 사용)
$('logout-btn').onclick = () => {
  if (!confirm('로그아웃할까요?')) return;
  state.token = ''; // 먼저 비운다 → ws.onclose 의 자동 재연결 가드가 재접속을 막는다
  localStorage.removeItem('sm_token');
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.ws) {
    const ws = state.ws;
    ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null; // 핸들러 떼고 조용히 닫기
    try { ws.close(); } catch { /* half-open 이면 실패해도 무시 */ }
    state.ws = null;
  }
  state.sessions.clear();
  state.selected = null;
  $('token-input').value = '';
  showGate('');
};

// 상단바 세션 동작 버튼(중단/리셋/종료): 현재 선택된 세션(state.selected)에 대해 동작.
// 정적 버튼이라 시작 시 한 번만 연결한다. 세션 미선택 시엔 render()가 .tb-sess 를 숨긴다.
$('tb-interrupt').onclick = () => {
  const id = state.selected;
  if (id) api('POST', `/sessions/${id}/interrupt`).catch(showErr);
};
$('tb-remove').onclick = () => {
  const id = state.selected;
  if (id && confirm('이 세션을 종료할까요?\n(대화 기록은 보관되며, 재시작해도 되살아나지 않습니다)')) api('DELETE', `/sessions/${id}`).catch(showErr);
};
$('tb-reset').onclick = () => {
  const s = state.selected ? state.sessions.get(state.selected) : null;
  if (s) resetSession(s);
};

// 상단바 더보기(⋮) 메뉴: 서버/로그아웃(전역) + 리셋/종료(세션). 좁은 폰에서 버튼이 안 잘리게 묶는다.
function closeMoreMenu() {
  $('tb-menu-pop').classList.add('hidden');
  $('tb-more').setAttribute('aria-expanded', 'false');
}
$('tb-more').onclick = (e) => {
  e.stopPropagation(); // 바깥 클릭 닫기 핸들러로 즉시 다시 닫히는 것 방지
  const pop = $('tb-menu-pop');
  const open = pop.classList.toggle('hidden') === false;
  $('tb-more').setAttribute('aria-expanded', String(open));
};
// 메뉴 항목을 누르면(각 항목의 기존 onclick 실행 후) 메뉴를 닫는다.
$('tb-menu-pop').addEventListener('click', () => closeMoreMenu());
// 바깥을 누르면 닫는다.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tb-menu')) closeMoreMenu();
});

// 새 대화: 이 세션을 닫고 같은 폴더로 새 세션을 연다(서버의 대화/컨텍스트 초기화).
async function resetSession(s) {
  if (!confirm('이 세션을 닫고 같은 폴더로 새 세션을 열까요?\n(대화와 컨텍스트가 초기화됩니다)')) return;
  try {
    const d = await api('POST', '/sessions', { cwd: s.cwd, title: s.title }); // 먼저 새 세션 확보
    state.sessions.set(d.session.id, d.session);
    await api('DELETE', `/sessions/${s.id}`).catch(() => {}); // 기존 세션 종료(실패해도 진행)
    state.sessions.delete(s.id);
    state.drafts.delete(s.id);
    state.images.delete(s.id);
    state.files.delete(s.id);
    state.prevStatus.delete(s.id);
    clearNotice(s.id);
    selectSession(d.session.id); // 새 세션으로 이동
  } catch (e) { showErr(e); }
}
// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showGate('토큰이 올바르지 않습니다.'); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- WebSocket ----------
function connect() {
  // 기존 소켓이 남아있으면 핸들러를 떼고 닫는다. 이렇게 해야 그 소켓의 onclose 가
  // 또 재연결을 걸어 소켓이 중복 생성되는 일을 막는다(깨어남 재연결 ↔ 자동 재연결이 겹칠 때).
  if (state.ws) {
    const old = state.ws;
    old.onopen = old.onclose = old.onmessage = old.onerror = null;
    try { old.close(); } catch { /* half-open 이면 실패할 수 있으나 무시 */ }
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => $('conn')?.classList.add('on'); // 연결 동그라미는 제거됨 → 있으면만 갱신
  ws.onclose = (e) => {
    if (state.ws !== ws) return; // 이미 새 소켓으로 교체된 낡은 소켓의 close 는 무시
    $('conn')?.classList.remove('on');
    if (e.code === 4001) { showGate('토큰이 올바르지 않습니다.'); return; }
    setTimeout(() => { if (state.token) connect(); }, 1500); // 자동 재연결
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

// 폰이 절전에서 깨어나거나 탭으로 돌아올 때의 소켓 죽음 대응.
// half-open(조용히 죽은) 소켓은 onclose 가 안 떠서 스스로 못 살아나고, 게다가
// readyState 는 죽은 소켓도 OPEN 으로 잘못 보고한다 → "열려있음"을 믿을 수 없다.
// 그래서 화면이 다시 보이는 순간 그냥 새로 연결하고(비용은 LAN 에서 무시할 수준),
// 최신 상태도 곧장 당겨와 재연결 스냅샷을 기다리지 않는다.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.token) return;
  connect();      // connect() 가 낡은 소켓을 안전히 정리하고 새로 연다
  pollSessions(); // 깨어나자마자 화면 즉시 최신화
});

function handleEvent(ev) {
  if (ev.type === 'snapshot') {
    state.sessions.clear();
    for (const s of ev.sessions) { state.sessions.set(s.id, s); state.prevStatus.set(s.id, s.status); }
    state.notified = state.notified.filter((id) => state.sessions.has(id)); // 재연결 시 큐 정리
    if (typeof ev.danger === 'boolean') state.danger = ev.danger; // 위험 모드 현재값 동기화
    if (ev.aux) { state.aux = ev.aux; renderAux(); } // 보조 서버 현재값 동기화
  } else if (ev.type === 'danger') {
    state.danger = ev.danger; // 다른 기기에서 토글한 결과 동기화
  } else if (ev.type === 'aux') {
    state.aux = ev.aux; renderAux(); // 다른 기기의 보조 서버 토글 동기화
  } else if (ev.type === 'session_update') {
    state.sessions.set(ev.session.id, ev.session);
    if (answered(ev.session)) enqueueNotice(ev.session.id);
  } else if (ev.type === 'session_removed') {
    state.sessions.delete(ev.sessionId);
    state.drafts.delete(ev.sessionId);
    state.images.delete(ev.sessionId);
    state.files.delete(ev.sessionId);
    state.prevStatus.delete(ev.sessionId);
    clearNotice(ev.sessionId);
    if (state.selected === ev.sessionId) state.selected = null;
  }
  render();
}

// ---------- 렌더 ----------
const STATUS_KO = {
  starting: '시작중', idle: '대기', thinking: '작업중',
  awaiting_permission: '승인대기', awaiting_question: '질문대기', done: '완료', error: '오류',
};

// 상태 배지. stalled 면 '정체?'를 덧붙여 "죽었나 일하는 중인가"를 구분해 보여준다.
function statusBadge(s) {
  const label = (STATUS_KO[s.status] || s.status) + (s.stalled ? ' ⚠정체?' : '');
  return `<span class="badge ${s.status}${s.stalled ? ' stalled' : ''}">${label}</span>`;
}

// 중요도(스티커) 우선순위: 내 조치가 필요한 세션일수록 위로 올라온다.
const STATUS_RANK = {
  awaiting_permission: 0, // 승인대기 — 나를 기다림
  awaiting_question: 1, // 질문대기 — 나를 기다림
  error: 2, // 오류
  done: 3, // 완료(답변 떴다)
  idle: 4, // 대기(내 턴)
  thinking: 5, // 작업중 — 조치 불필요
  starting: 6, // 시작중
};
// 정렬: 상태 중요도 → 정체 의심(위로) → 생성순.
function byImportance(a, b) {
  const ra = STATUS_RANK[a.status] ?? 99;
  const rb = STATUS_RANK[b.status] ?? 99;
  if (ra !== rb) return ra - rb;
  if (!!a.stalled !== !!b.stalled) return a.stalled ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

function render() {
  // 로그 스크롤 위치 보존: 재렌더(폴링/업데이트)로 읽던 위치가 튀지 않게.
  // 맨 아래 근처였으면 새 내용 따라 내려가고, 아니면 보던 위치를 그대로 둔다.
  const oldLog = $('log');
  const logPrevTop = oldLog ? oldLog.scrollTop : 0;
  const logNearBottom = oldLog ? oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 60 : true;

  // 폰 마스터-디테일: 유효한 세션(또는 서버 현황 페이지)이 선택됐을 때만 상세 화면을 보인다
  const isServers = state.selected === SERVERS_ID;
  const hasSel = isServers || (state.selected != null && state.sessions.has(state.selected));
  document.body.classList.toggle('viewing', hasSel);
  // 상단 세션 동작 버튼(중단/리셋/종료)은 실제 세션을 볼 때만 노출(서버 현황 페이지에선 숨김)
  document.querySelectorAll('.tb-sess').forEach((b) => b.classList.toggle('hidden', !hasSel || isServers));
  renderList();
  renderDetail();

  const newLog = $('log');
  if (newLog) newLog.scrollTop = logNearBottom ? newLog.scrollHeight : logPrevTop;
  // 입력창(textarea)은 세션이 바뀔 때만 새로 만들어지고(그 외 재렌더에선 그대로 유지),
  // 다른 세션 업데이트/폴링이 와도 파괴되지 않는다 → 포커스/커서/IME 조합이 끊기지 않음.
  // (예전엔 매 렌더마다 detail.innerHTML 을 통째로 갈아엎어 타이핑이 방해받았다.)
}

// 진행 중 세션은 폴더 무관 전부 목록에 띄운다.
// 종료(보관)한 세션은 서버가 재기동 시 복원하지 않으므로 애초에 목록에 없다 —
// 예전처럼 폴더당 1개로 접지 않는다(그 접기가 새로 만든 세션까지 가리던 문제였음).
function latestPerFolder(sessions) {
  return sessions;
}

function renderList() {
  const list = $('list');
  const sessions = latestPerFolder([...state.sessions.values()]).sort(byImportance);
  list.innerHTML = '';

  // 목록 맨 위 고정: "서버 현황" — 로컬에서 돌고 있는 서버들의 실행 상태 페이지(세션 아님)
  const srv = document.createElement('div');
  srv.className = 'item srv-nav' + (state.selected === SERVERS_ID ? ' active' : '');
  srv.onclick = () => selectSession(SERVERS_ID);
  srv.innerHTML = `
    <div class="row">
      <span class="title">🖥️ 서버 현황</span>
    </div>
    <div class="cwd">로컬에서 돌고 있는 서버</div>`;
  list.appendChild(srv);

  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'item' + (s.id === state.selected ? ' active' : '');
    el.onclick = () => selectSession(s.id);
    // 승인 대기면 목록에서 바로 허가/거부 (lite 대시보드와 동일하게)
    const perm = s.pending
      ? `<div class="list-perm">
        <div class="cmd">${esc(s.pending.summary)}</div>
        <div class="btns">
          <button class="yes" data-act="yes">✔ 허가</button>
          <button class="no" data-act="no">✘ 거부</button>
        </div>
      </div>`
      : '';
    el.innerHTML = `
      <div class="row">
        <span class="title">${esc(s.title)}</span>
        ${statusBadge(s)}
      </div>
      <div class="cwd">${esc(s.cwd)}</div>${perm}`;
    if (s.pending) {
      // 버튼 클릭이 항목 클릭(상세 이동)으로 번지지 않게 stopPropagation
      el.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = (e) => { e.stopPropagation(); decide(s, btn.dataset.act); };
      });
    }
    list.appendChild(el);
  }
}

// 상세 화면은 두 부분으로 나뉜다:
//  1) 입력창(textarea)을 포함한 정적 골격 — 세션이 바뀔 때만 buildDetailShell 로 새로 만든다.
//  2) 머리말/승인·질문/로그 등 동적 영역 — 매 렌더마다 updateDetailDynamic 로 갱신한다.
// 이렇게 나눠야 다른 세션 업데이트·폴링이 와도 입력창 DOM 이 파괴되지 않아
// 포커스/커서/한글(IME) 조합이 끊기지 않는다. (예전엔 매 렌더마다 통째로 갈아엎었다.)
function renderDetail() {
  const detail = $('detail');
  // 서버 현황 페이지: 세션 상세 대신 로컬 서버 목록을 그린다(골격은 진입 시 한 번만).
  if (state.selected === SERVERS_ID) {
    if (detail.dataset.sid !== SERVERS_ID) {
      buildServersShell(detail);
      detail.dataset.sid = SERVERS_ID;
    }
    return;
  }
  stopServersTimer(); // 서버 현황 페이지를 벗어나면 자동 새로고침 정지
  const s = state.selected ? state.sessions.get(state.selected) : null;
  if (!s) {
    if (detail.dataset.sid !== '') { detail.innerHTML = '<div class="empty">세션을 선택하거나 새로 만드세요.</div>'; detail.dataset.sid = ''; }
    return;
  }
  // 선택된 세션이 바뀌었을 때만 골격(입력창 포함)을 다시 만든다.
  if (detail.dataset.sid !== String(s.id)) {
    buildDetailShell(detail, s);
    detail.dataset.sid = String(s.id);
  }
  updateDetailDynamic(s);
}

// 정적 골격: 입력창/첨부/빠른실행 등 — 세션당 한 번만 만들고 이벤트를 연결한다.
function buildDetailShell(detail, s) {
  detail.innerHTML = `
    <div class="detail-head" id="detail-head"></div>
    <div id="detail-alert"></div>
    <div class="log" id="log"></div>
    <div class="composer">
      <div class="quick-actions" id="quick-actions">
        <button class="qa-btn" id="qa-status" title="현재 프로젝트 현황 정리 + 이전 대화 분석 후 이어가기">현황</button>
        <button class="qa-btn" id="qa-commit" title="변경사항 커밋 후 푸시">커푸</button>
        <button class="qa-btn qa-nav" id="qa-prev" title="이전 프로젝트">◀</button>
        <button class="qa-btn qa-nav" id="qa-next" title="다음 프로젝트">▶</button>
        <button class="qa-btn qa-refresh" id="qa-refresh" title="새로고침(다시 연결/동기화)">⟳</button>
        <button class="qa-btn qa-compact" id="qa-compact" title="컨텍스트 압축(/compact) — 이전 대화를 요약해 토큰 재독 비용을 줄임">CPT</button>
        <button class="qa-btn qa-danger ${state.danger ? 'on' : 'off'}" id="qa-danger"
          title="위험 모드: 켜면 모든 도구를 묻지 않고 자동 실행(AskUserQuestion만 폰 질문)">
          ${state.danger ? '위험<br>ON' : '안전<br>OFF'}</button>
      </div>
      <div class="thumbs" id="thumbs"></div>
      <div class="files" id="files"></div>
      <div class="composer-row">
        <button class="ghost attach-btn" id="attach" title="이미지 첨부(인라인)">🖼️</button>
        <button class="ghost attach-btn" id="attach-file" title="파일 첨부(이미지 포함, 작업폴더에 저장)">📎</button>
        <textarea id="prompt" placeholder="다음 명령을 입력…"></textarea>
        <button id="send">전송</button>
      </div>
      <input type="file" id="file" accept="image/*" multiple hidden>
      <input type="file" id="docfile" multiple hidden>
    </div>`;

  // 입력 중이던 초안을 복원하고, 타이핑할 때마다 초안을 저장한다 (재렌더에도 보존).
  // 골격은 세션당 한 번만 만들므로 이 input 리스너도 한 번만 연결된다(중복 누적 없음).
  const prompt = $('prompt');
  prompt.value = state.drafts.get(s.id) || '';
  prompt.addEventListener('input', () => state.drafts.set(s.id, prompt.value));

  // 첨부 이미지 미리보기/추가/삭제 (인라인)
  renderThumbs(s.id);
  $('attach').onclick = () => $('file').click();
  $('file').addEventListener('change', async (e) => {
    await addImages(s.id, e.target.files);
    e.target.value = ''; // 같은 파일 다시 선택 가능하게 초기화
    renderThumbs(s.id);
  });

  // 클립보드 붙여넣기(스크린샷 등) → 이미지 인라인 첨부
  prompt.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (imgFiles.length === 0) return; // 이미지가 없으면 일반 텍스트 붙여넣기로 진행
    e.preventDefault(); // 이미지 데이터가 텍스트로 들어가는 것 방지
    await addImages(s.id, imgFiles);
    renderThumbs(s.id);
  });

  // 첨부 파일 목록/추가/삭제 (디스크 저장)
  renderFiles(s.id);
  $('attach-file').onclick = () => $('docfile').click();
  $('docfile').addEventListener('change', async (e) => {
    await addFiles(s.id, e.target.files);
    e.target.value = '';
    renderFiles(s.id);
  });

  const send = () => {
    const text = prompt.value.trim();
    const imgs = state.images.get(s.id) || [];
    const fls = state.files.get(s.id) || [];
    if (!text && imgs.length === 0 && fls.length === 0) return;
    const payload = {
      text,
      images: imgs.map(({ mediaType, data }) => ({ mediaType, data })),
      files: fls.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    };
    api('POST', `/sessions/${s.id}/prompt`, payload).then(() => {
      state.drafts.delete(s.id);
      state.images.delete(s.id);
      state.files.delete(s.id);
      prompt.value = '';
      renderThumbs(s.id);
      renderFiles(s.id);
    }).catch(showErr);
  };
  $('send').onclick = send;
  prompt.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // IME 조합 중에는 무시 (한글 입력 도중 엔터로 전송되는 것 방지)
    if (e.isComposing || e.keyCode === 229) return;
    if (isMobile()) {
      // 모바일: 기존 동작 유지 (Ctrl/Cmd+Enter로 전송)
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); send(); }
    } else {
      // 데스크톱: 엔터=전송, 쉬프트+엔터=줄바꿈
      if (!e.shiftKey) { e.preventDefault(); send(); }
    }
  });

  // 빠른 실행 버튼: 자주 쓰는 프롬프트 두 개(현황/커푸)와 프로젝트 이동(◀▶)
  $('qa-status').onclick = () => sendQuickPrompt(s,
    '지금 이 프로젝트의 현황을 정리해줘. 이전 대화와 작업 상태(변경된 파일, 하던 작업, 미완료 항목)를 분석한 뒤, 무엇을 하던 중이었고 다음에 무엇을 해야 하는지 알려주고 이어서 진행해줘.');
  $('qa-commit').onclick = () => sendQuickPrompt(s,
    '변경사항을 커밋하고 푸시해줘. 커밋 메시지는 변경 내용을 요약해서 작성해줘.');
  $('qa-prev').onclick = () => navProject(-1);
  $('qa-next').onclick = () => navProject(1);
  // 새로고침: 페이지를 다시 불러와 WS 재연결 + 최신 스냅샷 수신
  $('qa-refresh').onclick = () => location.reload();
  // CPT: 이 세션 컨텍스트를 지금 압축(/compact)
  $('qa-compact').onclick = () => {
    if (!confirm('이 세션의 이전 대화를 지금 압축할까요?\n(요약본으로 줄여 토큰 재독 비용을 낮춥니다)')) return;
    api('POST', `/sessions/${s.id}/compact`).catch(showErr);
  };
  // 위험 모드 ON/OFF 토글: 서버에 반영 → danger 이벤트로 모든 기기 동기화
  $('qa-danger').onclick = () => toggleDanger();
}

// 동적 영역: 머리말/승인·질문/로그/위험버튼 상태 — 입력창은 건드리지 않는다.
function updateDetailDynamic(s) {
  // 머리말(제목·상태 배지·🔔 알림 버튼)
  $('detail-head').innerHTML = `
    <span class="title">${esc(s.title)}</span>
    ${statusBadge(s)}
    <button class="ghost nav" id="d-notice" title="알림 세션으로 이동(먼저 등록된 순)">🔔<span class="notice-count" id="d-notice-count">0</span></button>`;
  const noticeBtn = $('d-notice');
  $('d-notice-count').textContent = state.notified.length;
  noticeBtn.disabled = state.notified.length === 0;
  if (Date.now() < state.noticeFlashUntil) noticeBtn.classList.add('flash'); // 새 알림 후 2초간 깜빡
  noticeBtn.onclick = () => {
    // 이미 사라진 세션은 큐 앞에서 건너뛰고, 살아있는 첫 알림으로 이동
    while (state.notified.length && !state.sessions.has(state.notified[0])) state.notified.shift();
    const first = state.notified[0];
    if (first) selectSession(first); // selectSession 이 해당 알림을 큐에서 제거
  };

  // 승인/질문 영역 — 내용(승인/질문)이 바뀔 때만 다시 그린다.
  // 매 폴링마다 innerHTML 을 갈아엎으면 질문 선택지·기타 입력창의 포커스/타이핑(IME)이
  // 끊긴다. 같은 질문이 그대로면 DOM 을 그대로 두어 입력 중인 값이 살아있게 한다.
  const alertEl = $('detail-alert');
  const alertSig = (s.pending ? 'P:' + (s.pending.requestId || '') : '') +
                   (s.question ? 'Q:' + (s.question.requestId || '') : '');
  if (alertEl.dataset.sig !== alertSig) {
    alertEl.dataset.sig = alertSig;
    alertEl.innerHTML = (s.pending ? renderPerm(s) : '') + (s.question ? renderQuestion(s) : '');
    if (s.pending) {
      $('perm-yes').onclick = () => decide(s, 'yes');
      $('perm-no').onclick = () => decide(s, 'no');
    }
    if (s.question) wireQuestion(s);
  }

  // 로그 (스크롤 위치는 render() 가 보존/복원한다)
  const log = $('log');
  log.innerHTML = '';
  for (const m of s.messages) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.kind;
    el.innerHTML = `<div class="who">${whoLabel(m.kind)}</div><div class="body">${renderBody(m.text)}</div>`;
    log.appendChild(el);
  }

  // 위험 버튼 상태(다른 기기 토글로도 바뀔 수 있어 매 렌더마다 반영)
  const dgr = $('qa-danger');
  if (dgr) {
    dgr.className = `qa-btn qa-danger ${state.danger ? 'on' : 'off'}`;
    dgr.innerHTML = state.danger ? '위험<br>ON' : '안전<br>OFF';
  }
}

// 빠른 실행: 입력창을 거치지 않고 즉시 프롬프트를 전송한다 (폰에서 한 번 탭).
function sendQuickPrompt(s, text) {
  api('POST', `/sessions/${s.id}/prompt`, { text, images: [], files: [] }).catch(showErr);
}

// 위험 모드 토글. 켜면 모든 도구가 폰 승인 없이 자동 실행되므로, OFF→ON 시 한 번 확인한다.
// 서버가 danger 이벤트를 브로드캐스트하면 모든 기기의 버튼이 동기화된다.
function toggleDanger() {
  const next = !state.danger;
  if (next && !confirm('위험 모드를 켤까요?\n모든 도구가 승인 없이 자동 실행됩니다. (AskUserQuestion만 폰으로 질문)')) return;
  state.danger = next; // 낙관적 갱신 — 서버 응답/브로드캐스트로 곧 확정됨
  render();
  api('POST', '/danger', { danger: next }).catch((e) => { showErr(e); state.danger = !next; render(); });
}

// 프로젝트 이동: 생성순(createdAt)으로 고정 정렬해 ◀/▶ 가 튀지 않게 하고, 양끝에서 순환한다.
function navProject(dir) {
  const ordered = [...state.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (ordered.length === 0) return;
  const idx = ordered.findIndex((x) => x.id === state.selected);
  const next = idx < 0 ? ordered[0] : ordered[(idx + dir + ordered.length) % ordered.length];
  selectSession(next.id);
}

function renderPerm(s) {
  const p = s.pending;
  return `
    <div class="perm">
      <div class="q">${esc(p.title || (p.toolName + ' 실행을 허가할까요?'))}</div>
      <div class="cmd">${esc(p.summary)}</div>
      <div class="btns">
        <button class="yes" id="perm-yes">Yes 허가</button>
        <button class="no" id="perm-no">No 거부</button>
      </div>
    </div>`;
}

function decide(s, decision) {
  api('POST', `/sessions/${s.id}/approve`, { requestId: s.pending.requestId, decision }).catch(showErr);
}

// ---------- AskUserQuestion 선택지 ----------
function renderQuestion(s) {
  const blocks = s.question.questions.map((qq, qi) => {
    const type = qq.multiSelect ? 'checkbox' : 'radio';
    const opts = qq.options.map((o) => `
      <label class="qopt">
        <input type="${type}" name="q${qi}" value="${esc(o.label)}">
        <span class="qopt-main">${esc(o.label)}</span>
        ${o.description ? `<span class="qopt-desc">${esc(o.description)}</span>` : ''}
      </label>`).join('');
    return `
      <div class="qblock" data-qi="${qi}" data-question="${esc(qq.question)}">
        ${qq.header ? `<span class="qchip">${esc(qq.header)}</span>` : ''}
        <div class="qtext">${esc(qq.question)}</div>
        <div class="qopts">${opts}</div>
        <input class="qother" type="text" placeholder="기타(직접 입력)…">
      </div>`;
  }).join('');
  return `
    <div class="question" id="question">
      ${blocks}
      <div class="qactions">
        <button id="q-submit">선택 전송</button>
        <button class="ghost" id="q-skip">건너뛰기</button>
      </div>
    </div>`;
}

function wireQuestion(s) {
  const collect = () => {
    const answers = {};
    let missing = false;
    document.querySelectorAll('#question .qblock').forEach((blk) => {
      const checked = [...blk.querySelectorAll('input[name^="q"]:checked')].map((i) => i.value);
      const other = blk.querySelector('.qother').value.trim();
      const vals = other ? [...checked, other] : checked;
      if (vals.length === 0) missing = true;
      answers[blk.dataset.question] = vals.join(', ');
    });
    return missing ? null : answers;
  };
  $('q-submit').onclick = () => {
    const answers = collect();
    if (!answers) { alert('각 질문에 하나 이상 선택하거나 기타를 입력하세요.'); return; }
    api('POST', `/sessions/${s.id}/answer`, { requestId: s.question.requestId, answers }).catch(showErr);
  };
  $('q-skip').onclick = () => {
    api('POST', `/sessions/${s.id}/answer`, { requestId: s.question.requestId, answers: {} }).catch(showErr);
  };
}

// ---------- 새 세션 모달 + 폴더 피커 ----------
// 새 세션 폴더 피커가 처음 열릴 때 시작할 폴더 (위로 가면 드라이브 목록까지 갈 수 있음).
// 경로를 하드코딩하지 않고 서버에서 받아온다(서버 cwd 기준 자동 계산) → PC 이동/재클론에도 안 깨짐.
// 한 번 받으면 캐시. 실패하면 ''(드라이브 목록)로 폴백.
let START_DIR = null;
async function getStartDir() {
  if (START_DIR !== null) return START_DIR;
  try {
    const r = await api('GET', '/start-dir');
    START_DIR = r && typeof r.path === 'string' ? r.path : '';
  } catch {
    START_DIR = '';
  }
  return START_DIR;
}
async function loadPicker(path) {
  try {
    // 폴더 목록과 사용 빈도를 동시에 가져온다 (LAN 이라 둘 다 가볍다)
    const [b] = await Promise.all([
      api('GET', '/browse?path=' + encodeURIComponent(path || '')),
      refreshFreq(),
    ]);
    $('picker-here').textContent = b.isRoot ? '드라이브 선택' : b.path;
    if (!b.isRoot) $('cwd-input').value = b.path; // 현재 폴더를 cwd 후보로
    const list = $('picker-list');
    list.innerHTML = '';
    if (b.parent !== null) {
      const up = document.createElement('div');
      up.className = 'picker-row up';
      up.textContent = '⬆ 상위로';
      up.onclick = () => loadPicker(b.parent);
      list.appendChild(up);
    }
    // 자주 연 폴더를 위로: 사용 횟수 내림차순, 같으면 이름순(서버가 이미 이름순으로 줌)
    const freq = folderFreq;
    const dirs = [...b.dirs].sort((a, c) => (freq[c] || 0) - (freq[a] || 0) || a.localeCompare(c));
    for (const d of dirs) {
      const used = freq[d] || 0;
      // 전체 경로 대신 폴더 이름만 표시(현재 경로는 헤더·입력칸에 그대로 보인다).
      const name = d.split(/[\\/]/).filter(Boolean).pop() || d;
      const row = document.createElement('div');
      row.className = 'picker-row pick' + (state.pickerSelected.has(d) ? ' sel' : '');
      row.dataset.path = d;
      // 체크박스(다중 선택) + 폴더명(클릭 시 진입). 둘의 역할을 분리한다.
      row.innerHTML =
        `<button class="pick-check" title="여러 개 선택">${state.pickerSelected.has(d) ? '☑' : '☐'}</button>` +
        `<span class="pick-name" title="${esc(d)}">📁 ${esc(name)}${used ? ` <span class="freq">★${used}</span>` : ''}</span>`;
      row.querySelector('.pick-check').onclick = (e) => { e.stopPropagation(); togglePick(d); };
      row.querySelector('.pick-name').onclick = () => loadPicker(d);
      list.appendChild(row);
    }
    if (b.error) { const e = document.createElement('div'); e.className = 'picker-row'; e.textContent = '열 수 없음: ' + b.error; list.appendChild(e); }
  } catch (e) { showErr(e); }
}

// 다중 선택 토글 + 선택 막대/체크 표시 갱신
function togglePick(path) {
  if (state.pickerSelected.has(path)) state.pickerSelected.delete(path);
  else state.pickerSelected.add(path);
  renderPickerSelected();
  refreshPickRows();
}
// 현재 보이는 피커 행들의 체크 상태를 선택 집합과 동기화 (목록 재요청 없이)
function refreshPickRows() {
  document.querySelectorAll('#picker-list .picker-row[data-path]').forEach((row) => {
    const on = state.pickerSelected.has(row.dataset.path);
    row.classList.toggle('sel', on);
    const cb = row.querySelector('.pick-check');
    if (cb) cb.textContent = on ? '☑' : '☐';
  });
}
// 선택한 폴더 막대(칩 목록 + 비우기) + 생성 버튼 라벨 갱신
function renderPickerSelected() {
  // 폴더 선택 모드에선 다중선택/생성 UI 를 쓰지 않는다(현재 폴더만 고른다).
  if (state.pickerPick) {
    $('picker-sel')?.classList.add('hidden');
    const b = $('modal-create'); if (b) b.textContent = '이 폴더 선택';
    return;
  }
  const bar = $('picker-sel');
  const n = state.pickerSelected.size;
  if (bar) {
    if (n === 0) { bar.innerHTML = ''; bar.classList.add('hidden'); }
    else {
      bar.classList.remove('hidden');
      const chips = [...state.pickerSelected].map((p) =>
        `<span class="selchip" data-path="${esc(p)}">${esc(p.split(/[\\/]/).pop() || p)}<button class="selchip-x" title="해제">×</button></span>`).join('');
      bar.innerHTML = `<div class="sel-head">선택한 폴더 ${n}개<button class="ghost" id="sel-clear">비우기</button></div><div class="sel-chips">${chips}</div>`;
      $('sel-clear').onclick = () => { state.pickerSelected.clear(); renderPickerSelected(); refreshPickRows(); };
      bar.querySelectorAll('.selchip').forEach((c) =>
        c.querySelector('.selchip-x').onclick = () => { state.pickerSelected.delete(c.dataset.path); renderPickerSelected(); refreshPickRows(); });
    }
  }
  const btn = $('modal-create');
  if (btn) btn.textContent = n > 0 ? `${n}개 세션 생성` : '생성';
}

$('new-btn').onclick = async () => {
  state.pickerPick = null; // 세션 생성 모드
  $('modal-title').textContent = '새 세션';
  $('modal-title-group').classList.remove('hidden');
  $('picker-sel').classList.remove('hidden');
  $('modal').classList.remove('hidden');
  $('modal-err').textContent = '';
  state.pickerSelected.clear();
  renderPickerSelected();
  loadPicker(await getStartDir());
};
// 폴더 하나만 고르는 피커(보조 서버 등에서 재사용). onPick(경로) 콜백 호출.
async function openFolderPicker(onPick) {
  state.pickerPick = onPick;
  $('modal-title').textContent = '폴더 선택';
  $('modal-title-group').classList.add('hidden'); // 제목 입력 숨김
  $('picker-sel').classList.add('hidden'); // 다중선택 막대 숨김
  state.pickerSelected.clear();
  $('modal-err').textContent = '';
  $('modal-create').textContent = '이 폴더 선택';
  $('modal').classList.remove('hidden');
  loadPicker($('aux-dir').value.trim() || (await getStartDir()));
}
$('modal-cancel').onclick = () => { state.pickerPick = null; state.pickerSelected.clear(); renderPickerSelected(); $('modal').classList.add('hidden'); };
$('modal-create').onclick = async () => {
  // 폴더 선택 모드: 현재 폴더를 콜백에 넘기고 닫는다(세션 생성 안 함).
  if (state.pickerPick) {
    const dir = $('cwd-input').value.trim();
    if (!dir) { $('modal-err').textContent = '폴더를 선택하세요.'; return; }
    const cb = state.pickerPick; state.pickerPick = null;
    $('modal').classList.add('hidden');
    cb(dir);
    return;
  }
  const sel = [...state.pickerSelected];
  // 다중 선택이 있으면 일괄 생성 (제목은 각 폴더명을 쓰므로 입력칸 무시)
  if (sel.length > 0) {
    const errs = [];
    let last = null;
    for (const cwd of sel) {
      try {
        const d = await api('POST', '/sessions', { cwd });
        state.sessions.set(d.session.id, d.session);
        last = d.session.id;
      } catch (e) { errs.push(`${cwd.split(/[\\/]/).pop() || cwd}: ${e.message}`); }
    }
    if (last) state.selected = last;
    state.pickerSelected.clear();
    renderPickerSelected();
    if (errs.length) { $('modal-err').textContent = errs.join('\n'); render(); }
    else { $('modal').classList.add('hidden'); $('cwd-input').value = ''; $('title-input').value = ''; render(); }
    return;
  }
  // 단일 생성 (직접 입력 또는 현재 폴더)
  const cwd = $('cwd-input').value.trim();
  const title = $('title-input').value.trim();
  if (!cwd) { $('modal-err').textContent = '폴더를 선택하거나 직접 입력하세요.'; return; }
  api('POST', '/sessions', { cwd, title })
    .then((d) => { state.sessions.set(d.session.id, d.session); state.selected = d.session.id; $('modal').classList.add('hidden'); $('cwd-input').value = ''; $('title-input').value = ''; render(); })
    .catch((e) => { $('modal-err').textContent = e.message; });
};

// ---------- 이미지 첨부 ----------
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 원본 파일 8MB 제한

function pendingImages(id) {
  let arr = state.images.get(id);
  if (!arr) { arr = []; state.images.set(id, arr); }
  return arr;
}

async function addImages(id, fileList) {
  const files = [...(fileList || [])].filter((f) => f.type.startsWith('image/'));
  const arr = pendingImages(id);
  for (const f of files) {
    if (arr.length >= MAX_IMAGES) { showErr({ message: `이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있어요.` }); break; }
    if (f.size > MAX_IMAGE_BYTES) { showErr({ message: `${f.name}: 8MB를 넘어 제외했어요.` }); continue; }
    try {
      const { mediaType, data } = await readImage(f);
      arr.push({ name: f.name || 'image', mediaType, data });
    } catch (e) { showErr(e); }
  }
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result); // data:<mediaType>;base64,<data>
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (!m) return reject(new Error('이미지를 읽지 못했어요.'));
      resolve({ mediaType: m[1], data: m[2] });
    };
    r.onerror = () => reject(new Error('이미지를 읽지 못했어요.'));
    r.readAsDataURL(file);
  });
}

function renderThumbs(id) {
  const box = $('thumbs');
  if (!box) return;
  const arr = state.images.get(id) || [];
  box.innerHTML = '';
  arr.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `<img src="data:${img.mediaType};base64,${img.data}" alt=""><button class="thumb-x" title="삭제">×</button>`;
    el.querySelector('.thumb-x').onclick = () => { arr.splice(i, 1); renderThumbs(id); };
    box.appendChild(el);
  });
}

// ---------- 파일 첨부 (디스크 저장 → Claude 가 경로로 읽음) ----------
const MAX_FILES = 10;
const MAX_FILE_BYTES = 30 * 1024 * 1024; // 파일당 30MB (서버 본문 한도 50MB 안쪽)

function pendingFiles(id) {
  let arr = state.files.get(id);
  if (!arr) { arr = []; state.files.set(id, arr); }
  return arr;
}

async function addFiles(id, fileList) {
  const files = [...(fileList || [])];
  const arr = pendingFiles(id);
  for (const f of files) {
    if (arr.length >= MAX_FILES) { showErr({ message: `파일은 최대 ${MAX_FILES}개까지 첨부할 수 있어요.` }); break; }
    if (f.size > MAX_FILE_BYTES) { showErr({ message: `${f.name}: 30MB를 넘어 제외했어요.` }); continue; }
    try {
      const data = await readFileBase64(f);
      arr.push({ name: f.name || 'file', mediaType: f.type || '', data, size: f.size });
    } catch (e) { showErr(e); }
  }
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result); // data:<mime?>;base64,<data>
      const comma = url.indexOf(',');
      if (comma < 0) return reject(new Error('파일을 읽지 못했어요.'));
      resolve(url.slice(comma + 1));
    };
    r.onerror = () => reject(new Error('파일을 읽지 못했어요.'));
    r.readAsDataURL(file);
  });
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderFiles(id) {
  const box = $('files');
  if (!box) return;
  const arr = state.files.get(id) || [];
  box.innerHTML = '';
  arr.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'filechip';
    el.innerHTML = `<span class="fc-name">📄 ${esc(f.name)}</span><span class="fc-size">${fmtSize(f.size)}</span><button class="fc-x" title="삭제">×</button>`;
    el.querySelector('.fc-x').onclick = () => { arr.splice(i, 1); renderFiles(id); };
    box.appendChild(el);
  });
}

// ---------- 본문 렌더 (마크다운 표 + 굵게 + 인라인 코드) ----------
// 보안: 먼저 esc() 로 전부 이스케이프한 뒤, 살아남은 마크다운 기호만 태그로 바꾼다.
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
// 표 구분선인가? 예: |---|:--:|--| / --- | --- 등
function isTableSep(line) {
  if (!line || line.indexOf('|') === -1) return false;
  const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
  return cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
}
function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}
function renderBody(text) {
  const lines = String(text == null ? '' : text).split('\n');
  let html = '';
  let buf = [];
  const flush = () => { if (buf.length) { html += inlineMd(buf.join('\n')); buf = []; } };
  let i = 0;
  while (i < lines.length) {
    // 표 시작: 헤더 줄에 '|' 가 있고 바로 다음 줄이 구분선
    if (lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return r && l ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i])); i++;
      }
      const al = (j) => aligns[j] ? ` style="text-align:${aligns[j]}"` : '';
      let t = '<table class="md"><thead><tr>';
      head.forEach((c, j) => { t += `<th${al(j)}>${inlineMd(c)}</th>`; });
      t += '</tr></thead><tbody>';
      for (const r of rows) {
        t += '<tr>';
        head.forEach((_, j) => { t += `<td${al(j)}>${inlineMd(r[j] || '')}</td>`; });
        t += '</tr>';
      }
      t += '</tbody></table>';
      html += t;
    } else {
      buf.push(lines[i]); i++;
    }
  }
  flush();
  return html;
}

// ---------- 유틸 ----------
function whoLabel(kind) {
  return { text: 'Claude', tool: '도구', result: '결과', system: '시스템', user: '나', error: '오류' }[kind] || kind;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function showErr(e) { alert(e.message || String(e)); }

// ---------- 보조 서버(정적/업로드) ----------
// 현재 상태(state.aux)를 모달·상단 버튼에 반영.
function renderAux() {
  const anyOn = state.aux.static.running || state.aux.upload.running;
  $('aux-btn')?.classList.toggle('on', anyOn);
  // 서버가 메뉴(⋮) 안에 숨어 있으므로, 켜져 있으면 ⋮ 버튼에도 초록 표시를 준다.
  $('tb-more')?.classList.toggle('has-active', anyOn);
  for (const kind of ['static', 'upload']) {
    const s = state.aux[kind] || { running: false };
    const stateEl = $(`aux-${kind}-state`);
    if (stateEl) {
      if (s.running) {
        const url = `http://${location.hostname}:${s.port}/`;
        stateEl.classList.add('on');
        stateEl.innerHTML = `켜짐 · <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a><br><span class="muted">${esc(s.dir || '')}</span>`;
      } else {
        stateEl.classList.remove('on');
        stateEl.textContent = '꺼짐';
      }
    }
    const startBtn = $(`aux-${kind}-start`); if (startBtn) startBtn.disabled = false;
    const stopBtn = $(`aux-${kind}-stop`); if (stopBtn) stopBtn.disabled = !s.running;
  }
}
async function auxAction(kind, action) {
  $('aux-err').textContent = '';
  const dir = $('aux-dir').value.trim();
  if (action === 'start' && !dir) { $('aux-err').textContent = '대상 폴더를 선택하세요.'; return; }
  try {
    const d = await api('POST', '/aux', { kind, action, dir });
    state.aux = d.aux; renderAux();
  } catch (e) { $('aux-err').textContent = e.message; }
}
$('aux-btn').onclick = async () => {
  $('aux-err').textContent = '';
  // 대상 폴더 기본값: 선택된 세션의 cwd(있으면)
  if (!$('aux-dir').value.trim() && state.selected) {
    const s = state.sessions.get(state.selected);
    if (s?.cwd) $('aux-dir').value = s.cwd;
  }
  $('aux-modal').classList.remove('hidden');
  try { const d = await api('GET', '/aux'); state.aux = d.aux; } catch { /* 스냅샷 값 유지 */ }
  renderAux();
};
$('aux-close').onclick = () => $('aux-modal').classList.add('hidden');
$('aux-pick').onclick = () => {
  $('aux-modal').classList.add('hidden'); // 피커 모달과 겹치지 않게 잠시 숨김
  openFolderPicker((dir) => { $('aux-dir').value = dir; $('aux-modal').classList.remove('hidden'); renderAux(); });
};
$('aux-static-start').onclick = () => auxAction('static', 'start');
$('aux-static-stop').onclick = () => auxAction('static', 'stop');
$('aux-upload-start').onclick = () => auxAction('upload', 'start');
$('aux-upload-stop').onclick = () => auxAction('upload', 'stop');

// ---------- 서버 현황 페이지 ----------
// 로컬에서 돌고 있는 서버(알려진 고정 서버 + 기타 LISTEN 포트)를 보여준다.
// 세션이 아니라 목록 맨 위 "🖥️ 서버 현황" 특수 항목을 누르면 이 페이지가 상세 영역에 뜬다.
function stopServersTimer() {
  if (state.serversTimer) { clearInterval(state.serversTimer); state.serversTimer = null; }
}

function buildServersShell(detail) {
  detail.innerHTML = `
    <div class="detail-head">
      <span class="title">🖥️ 서버 현황</span>
      <button class="ghost nav" id="srv-refresh" title="새로고침">⟳</button>
    </div>
    <div class="srv-page" id="srv-page"><div class="empty">불러오는 중…</div></div>`;
  $('srv-refresh').onclick = () => refreshServers();
  refreshServers();
  // 보는 동안 5초마다 자동 갱신(페이지를 벗어나면 renderDetail 이 타이머를 끈다)
  stopServersTimer();
  state.serversTimer = setInterval(() => {
    if (state.selected === SERVERS_ID) refreshServers(); else stopServersTimer();
  }, 5000);
}

async function refreshServers() {
  const page = $('srv-page');
  if (!page) return;
  // 재렌더로 지워지지 않게, 체크돼 있던 프로세스 PID 를 미리 기억한다.
  const checked = new Set(
    Array.from(page.querySelectorAll('.mem-chk:checked')).map((c) => Number(c.value)),
  );
  try {
    const [d, apps, mem] = await Promise.all([
      api('GET', '/servers'),
      api('GET', '/app-processes').catch((e) => ({ error: e.message || String(e) })),
      api('GET', '/processes').catch((e) => ({ error: e.message || String(e) })),
    ]);
    page.innerHTML = renderServersHtml(d) + renderAppProcsHtml(apps) + renderMemHtml(mem);
    // 이전 선택 복원 + 종료 버튼 연결
    for (const pid of checked) {
      const el = page.querySelector(`.mem-chk[value="${pid}"]`);
      if (el) el.checked = true;
    }
    wireMemKill();
  } catch (e) {
    page.innerHTML = `<div class="empty">불러오지 못했어요: ${esc(e.message || String(e))}</div>`;
  }
}

// 앱 프로세스 — VS Code/Edge/Chrome 인스턴스를 앱으로 묶어 보여준다. 앱 헤더 체크박스로
// 그룹 전체를 한 번에 선택, 행 체크박스로 개별 선택 → '선택 종료'로 taskkill. 체크박스는
// RAM 섹션과 같은 .mem-chk 를 써서 wireMemKill 이 두 섹션을 통합 처리한다(종료 버튼 공유).
function renderAppProcsHtml(apps) {
  if (!apps || apps.error) {
    return `<div class="srv-grp">🧩 앱 프로세스</div>
      <div class="empty">앱 프로세스를 불러오지 못했어요${apps && apps.error ? `: ${esc(apps.error)}` : ''}</div>`;
  }
  const groups = apps.groups || [];
  if (!groups.length) {
    return `<div class="srv-grp mem-head"><span>🧩 앱 프로세스</span></div>
      <div class="empty">실행 중인 VS Code·Edge·Chrome 없음</div>`;
  }
  const sections = groups.map((g) => {
    const rows = g.procs.map((p) => {
      const locked = p.self || p.protectedProc;
      return `
      <label class="mem-row app-row${locked ? ' locked' : ''}">
        <input type="checkbox" class="mem-chk" value="${p.pid}" data-app="${esc(g.app)}" ${locked ? 'disabled' : ''}>
        <span class="mem-name">${esc(g.label)}</span>
        <span class="mem-pid">pid ${p.pid}</span>
        <span class="mem-mb">${p.mb} MB</span>
      </label>`;
    }).join('');
    return `
      <div class="app-grp-head">
        <label class="app-grp-sel">
          <input type="checkbox" class="app-grp-chk" data-app="${esc(g.app)}">
          <span class="app-grp-name">${esc(g.label)}</span>
        </label>
        <span class="app-grp-meta">${g.count}개 · ${g.totalMb} MB</span>
      </div>
      ${rows}`;
  }).join('');
  return `
    <div class="srv-grp mem-head">
      <span>🧩 앱 프로세스</span>
      <button class="ghost danger kill-btn" id="app-kill" disabled>선택 종료</button>
    </div>
    ${sections}`;
}

// RAM 사용현황 — "서버 현황" 밑 섹션. 시스템 메모리 요약 + 프로세스별 사용량(상위).
// 각 행에 체크박스가 있어 선택 후 '선택 종료'로 taskkill 한다. 서버 자신/보호 프로세스는
// 체크박스가 비활성(서버가 거부하지만 UI 에서도 미리 막는다).
function renderMemHtml(mem) {
  if (!mem || mem.error) {
    return `<div class="srv-grp">🧠 RAM 사용현황</div>
      <div class="empty">RAM 정보를 불러오지 못했어요${mem && mem.error ? `: ${esc(mem.error)}` : ''}</div>`;
  }
  const procs = mem.procs || [];
  const maxMb = procs.reduce((m, p) => Math.max(m, p.mb), 1);
  const rows = procs.map((p) => {
    const pct = Math.round((p.mb / maxMb) * 100);
    const locked = p.self || p.protectedProc;
    const tag = p.self ? ' <span class="mem-tag self">이 서버</span>'
      : p.protectedProc ? ' <span class="mem-tag lock">보호됨</span>' : '';
    return `
      <label class="mem-row${locked ? ' locked' : ''}">
        <input type="checkbox" class="mem-chk" value="${p.pid}" ${locked ? 'disabled' : ''}>
        <span class="mem-name">${esc(p.name)}${tag}</span>
        <span class="mem-pid">pid ${p.pid}</span>
        <span class="mem-bar"><span class="mem-bar-fill" style="width:${pct}%"></span></span>
        <span class="mem-mb">${p.mb} MB</span>
      </label>`;
  }).join('');
  const usedGb = (mem.usedMb / 1024).toFixed(1);
  const totGb = (mem.totalMb / 1024).toFixed(1);
  const freeGb = (mem.freeMb / 1024).toFixed(1);
  const warn = mem.usedPct >= 85 ? ' warn' : '';
  return `
    <div class="srv-grp mem-head">
      <span>🧠 RAM 사용현황</span>
      <button class="ghost danger kill-btn" id="mem-kill" disabled>선택 종료</button>
    </div>
    <div class="mem-summary${warn}">
      <span><b>${usedGb}</b> / ${totGb} GB 사용 (${mem.usedPct}%) · 여유 ${freeGb} GB</span>
      <span class="mem-track"><span class="mem-track-fill" style="width:${mem.usedPct}%"></span></span>
    </div>
    ${rows || '<div class="empty">프로세스 정보 없음</div>'}`;
}

// 앱 프로세스 섹션과 RAM 섹션이 같은 .mem-chk 체크박스를 공유한다. 두 섹션의 '선택 종료'
// 버튼(.kill-btn)은 전체 선택분을 함께 종료하고, 앱 그룹 헤더 체크박스(.app-grp-chk)는
// 그 앱의 (비잠금) 행을 한 번에 토글한다.
function wireMemKill() {
  const page = $('srv-page');
  if (!page) return;
  const buttons = Array.from(page.querySelectorAll('.kill-btn'));
  if (!buttons.length) return;
  const chks = () => Array.from(page.querySelectorAll('.mem-chk:checked'));
  const sync = () => {
    const n = chks().length;
    buttons.forEach((b) => {
      b.disabled = n === 0;
      b.textContent = n ? `선택 종료 (${n})` : '선택 종료';
    });
    // 그룹 헤더 상태 갱신: 그 앱 행이 모두 선택 → 체크, 일부만 → indeterminate.
    page.querySelectorAll('.app-grp-chk').forEach((g) => {
      const app = g.getAttribute('data-app');
      const rows = Array.from(page.querySelectorAll(`.mem-chk[data-app="${app}"]:not([disabled])`));
      const on = rows.filter((r) => r.checked).length;
      g.checked = rows.length > 0 && on === rows.length;
      g.indeterminate = on > 0 && on < rows.length;
    });
  };
  page.querySelectorAll('.mem-chk').forEach((c) => c.addEventListener('change', sync));
  page.querySelectorAll('.app-grp-chk').forEach((g) => {
    g.addEventListener('change', () => {
      const app = g.getAttribute('data-app');
      page.querySelectorAll(`.mem-chk[data-app="${app}"]:not([disabled])`)
        .forEach((r) => { r.checked = g.checked; });
      sync();
    });
  });
  sync();
  const doKill = async () => {
    const pids = chks().map((c) => Number(c.value));
    if (!pids.length) return;
    if (!confirm(`선택한 ${pids.length}개 프로세스를 강제 종료할까요?\npid: ${pids.join(', ')}`)) return;
    buttons.forEach((b) => { b.disabled = true; });
    const results = await Promise.all(
      pids.map((pid) => api('POST', '/kill', { pid }).catch((e) => ({ ok: false, pid, reason: e.message || String(e) }))),
    );
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      alert('일부 종료 실패:\n' + failed.map((r) => `pid ${r.pid}: ${r.reason || '실패'}`).join('\n'));
    }
    refreshServers();
  };
  buttons.forEach((b) => { b.onclick = doKill; });
}

function renderServersHtml(d) {
  const known = d.known || [];
  const others = d.others || [];
  const dot = (up) => `<span class="srv-dot ${up ? 'up' : 'down'}"></span>`;
  const row = (up, name, port, sub) => {
    // 켜진 서버는 같은 호스트(폰이 접속한 IP)의 해당 포트를 새 탭으로 연다. 오른쪽 ↗ 는 링크 힌트.
    // 꺼진 서버는 열 게 없으므로 링크 없이 평범한 줄로 둔다.
    const inner = `
      <div class="srv-main">${dot(up)}<span class="srv-name">${esc(name)}</span><span class="srv-port">:${port}</span>${up ? '<span class="srv-open">↗</span>' : ''}</div>
      ${sub ? `<div class="srv-sub">${sub}</div>` : ''}`;
    return up
      ? `<a class="srv-row up srv-link" href="//${location.hostname}:${port}" target="_blank" rel="noopener">${inner}</a>`
      : `<div class="srv-row down">${inner}</div>`;
  };

  // 프로젝트별로 묶어 프로젝트 이름을 그룹 제목으로 표시한다(레지스트리 첫 등장 순서 유지).
  // 같은 프로젝트의 서버들이 흩어져 있어도 한 제목 아래로 모인다(예: claudia 4개).
  const groups = [];
  const gIndex = new Map();
  for (const s of known) {
    const key = s.project || '(기타)';
    let g = gIndex.get(key);
    if (!g) { g = { project: key, servers: [] }; gIndex.set(key, g); groups.push(g); }
    g.servers.push(s);
  }
  const knownRows = groups.map((g) => {
    const rows = g.servers.map((s) => {
      // 프로젝트는 그룹 제목으로 올렸으니 서브줄에선 뺀다(설명 · pid 만 남김).
      const sub = `${esc(s.desc || '')}${s.up && s.pid ? ` · pid ${s.pid}` : ''}`;
      return row(s.up, s.name, s.port, sub);
    }).join('');
    const upN = g.servers.filter((s) => s.up).length;
    return `<div class="srv-grp srv-proj-grp">${esc(g.project)} <span class="srv-muted">${upN}/${g.servers.length}</span></div>${rows}`;
  }).join('');

  const otherRows = others.length
    ? `<div class="srv-grp">기타 (레지스트리 밖)</div>` +
      others.map((o) => row(true, o.name || '(알 수 없음)', o.port, `pid ${o.pid ?? '?'}`)).join('')
    : '';

  const upCount = known.filter((s) => s.up).length;
  const when = d.at ? new Date(d.at).toLocaleTimeString('ko-KR') : '';
  const hidden = d.hidden ? ` · <span class="srv-muted">시스템 ${d.hidden}개 숨김</span>` : '';
  return `
    <div class="srv-summary">고정 서버 <b>${upCount}/${known.length}</b> 실행 중${others.length ? ` · 기타 ${others.length}개` : ''}${hidden} · ${when}</div>
    ${knownRows}${otherRows}`;
}

// ---------- 시작 ----------
if (state.token) enterApp(); else showGate('');
