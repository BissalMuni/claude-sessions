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
  sideTab: 'sessions', // 사이드바 탭: 'sessions' | 'files'
  fileDir: '', // 파일 트리의 현재 폴더(탭 전환 시 위치 유지)
  fileTreeFor: undefined, // 파일 트리가 어느 세션 기준으로 열렸는지(세션 바뀌면 cwd 로 재루트)
  treeOpen: new Set(), // 트리에서 펼쳐 둔 폴더 경로들(접기/펼치기 상태 유지)
  openFile: null, // 파일 패널(분할 화면)로 열린 파일 { name, path, size }
  restricted: false, // root 샌드박스 계정 여부(스냅샷 동기화) — 관리 UI(서버 현황/위험모드) 숨김
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
  // 파일 탭이 열려 있으면 트리를 새 세션의 작업 폴더로 다시 뿌린다
  // (파일 패널은 분할 화면이라 세션을 바꿔도 열린 채 유지된다)
  if (state.sideTab === 'files') void loadTreeForCurrent();
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
// 주기적으로 전체 상태를 가져와 병합한다(폴링 안전망).
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollSessions, 7000);
}
// 세션 상태의 변화 지문(updatedAt 등). 같으면 다시 그릴 필요가 없다.
function sessionsSig(list) {
  return list
    // 컨텍스트 총량도 지문에 넣는다. 안 넣으면 updatedAt 이 그대로일 때 링이 안 갱신된다.
    .map((s) => `${s.id}:${s.updatedAt}:${s.stalled ? 1 : 0}:${s.context ? s.context.total : ''}:${s.pending ? s.pending.requestId : ''}:${s.question ? s.question.requestId : ''}`)
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
  const id = $('id-input').value.trim();
  const pw = $('pw-input').value;
  if (!pw) return;
  // 서버 자격증명은 "아이디:비밀번호" 합성 문자열 — 기존 Bearer/?token= 경로를 그대로 탄다.
  // 아이디를 비우면 비번 칸 값을 토큰 원문으로 보낸다(단일 SCREEN_TOKEN 모드 — 아이디 없음).
  state.token = id ? id + ':' + pw : pw;
  localStorage.setItem('sm_token', state.token);
  enterApp();
};
$('id-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pw-input').focus(); });
$('pw-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-btn').click(); });
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
  // 파일 탐색기 상태도 비운다 — 안 비우면 다음 계정 화면에 이전 계정의 파일/폴더가 남는다
  state.openFile = null;
  state.fileDir = '';
  state.fileTreeFor = undefined;
  state.treeOpen.clear();
  $('file-tree').innerHTML = '';
  $('file-pane').innerHTML = '';
  updatePaneVisibility();
  setSideTab('sessions');
  $('id-input').value = '';
  $('pw-input').value = '';
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
// 위험 모드 ON/OFF 토글(전역): ⋮ 메뉴 항목. 서버에 반영 → danger 이벤트로 모든 기기 동기화.
$('tb-danger').onclick = () => toggleDanger();

// 서버 재시작. 서버가 스스로 되살아나는 게 아니라 start-server.bat 창(:loop)이 다시 띄운다
// — 그 감시자가 없으면 서버가 409 로 거부하므로, 눌러서 영영 죽는 사고는 안 난다.
// 끊긴 뒤 복구는 ws.onclose 의 자동 재연결(1.5초 간격)이 알아서 한다.
$('tb-restart').onclick = async () => {
  if (!confirm('컨트롤러 서버를 재시작할까요?\n돌고 있는 세션이 모두 내려갔다가 복원됩니다(10초쯤 걸립니다).')) return;
  try {
    await api('POST', '/restart');
    alert('재시작 중입니다. 서버가 다시 뜨면 자동으로 다시 연결됩니다.');
  } catch (e) {
    showErr(e); // 409 = 감시자 없음(이 창은 start-server.bat 로 띄운 게 아님)
  }
};
$('tb-diagnose').onclick = () => {
  const id = state.selected;
  if (id) openDiagnose(id);
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

// 대화를 텍스트로 직렬화. 너무 길면 '앞부분'을 잘라 최근(뒤쪽)만 남긴다 — 1 2 3 4 5 → 3 4 5.
const MIGRATE_MAX_CHARS = 48000; // 대략 1.2~1.6만 토큰 — 새 세션에 옮길 대화 상한
function serializeConversation(s) {
  const parts = [];
  for (const m of s.messages || []) {
    const text = (m.text || '').trim();
    if (!text) continue;
    parts.push(`[${whoLabel(m.kind)}]\n${text}`);
  }
  let body = parts.join('\n\n');
  let truncated = false;
  if (body.length > MIGRATE_MAX_CHARS) {
    // 뒤에서부터 MIGRATE_MAX_CHARS 만큼 남기고, 잘린 지점이 메시지 경계에 가깝게 맞춘다.
    let cut = body.length - MIGRATE_MAX_CHARS;
    const nextBoundary = body.indexOf('\n\n[', cut);
    if (nextBoundary !== -1 && nextBoundary - cut < 4000) cut = nextBoundary + 2;
    body = body.slice(cut);
    truncated = true;
  }
  const header = truncated
    ? '아래는 이전 세션 대화의 뒷부분(최근 내용만, 앞부분 생략)이다. 맥락을 파악하고 이어서 진행해줘.'
    : '아래는 이전 세션의 대화 기록이다. 맥락을 파악하고 이어서 진행해줘.';
  return `${header}\n\n----- 이전 대화 -----\n\n${body}`;
}

// 클립보드 복사. LAN(http)은 보안 컨텍스트가 아니라 navigator.clipboard 가 없을 수 있어 폴백을 둔다.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 폴백으로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// 복사+인계: 현재 대화를 클립보드에 복사한 뒤, 같은 폴더로 새 세션을 열어
// 그 대화를 붙여넣고 전송한다. (API가 느려질 때 새 세션으로 갈아타는 용도)
async function copyAndMigrate(s) {
  const text = serializeConversation(s);
  await copyToClipboard(text); // 실패해도 인계는 진행(클립보드는 보조 수단)
  if (!confirm('이 대화를 복사해 같은 폴더로 새 세션을 열고 이어갈까요?\n(현재 세션은 종료되고, 복사한 대화가 새 세션으로 전송됩니다)')) return;
  try {
    const d = await api('POST', '/sessions', { cwd: s.cwd, title: s.title }); // 먼저 새 세션 확보
    state.sessions.set(d.session.id, d.session);
    await api('POST', `/sessions/${d.session.id}/prompt`, { text, images: [], files: [] }); // 대화 인계 + 전송
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
  if (res.status === 401) { showGate('아이디 또는 비밀번호가 올바르지 않습니다.'); throw new Error('unauthorized'); }
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
    if (e.code === 4001) { showGate('아이디 또는 비밀번호가 올바르지 않습니다.'); return; }
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
    state.restricted = !!ev.restricted; // 샌드박스 계정: 서버 현황/위험모드 등 관리 UI 숨김
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

// 컨텍스트 사용량 링. VS Code 확장의 원형 게이지와 같은 데이터(SDK getContextUsage)다.
// 폰에는 잔여가 전혀 안 보여서 컨텍스트가 조용히 불어나도 알 수 없었고, 그게 곧 느림이었다.
function contextRing(s) {
  const c = s.context;
  if (!c || !c.max) return '';
  const pct = Math.max(0, Math.min(100, c.pct));
  const R = 7;
  const C = 2 * Math.PI * R;
  const on = (C * pct) / 100;
  const level = pct >= 75 ? 'hot' : pct >= 50 ? 'warm' : 'ok';
  const k = (n) => Math.round(n / 1000) + 'k';
  const tip =
    `컨텍스트 ${k(c.total)} / ${k(c.max)} (${pct}%)` +
    (c.compactAt ? ` · 자동압축 ${k(c.compactAt)}` : '');
  return `<span class="ctx ${level}" title="${esc(tip)}"><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><circle class="ctx-track" cx="9" cy="9" r="${R}"></circle><circle class="ctx-arc" cx="9" cy="9" r="${R}" stroke-dasharray="${on.toFixed(2)} ${(C - on).toFixed(2)}"></circle></svg><b>${k(c.total)}</b></span>`;
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

  // 폰 마스터-디테일: 유효한 세션(또는 서버 현황 페이지/파일 탭)이 선택됐을 때만 상세 화면을 보인다
  const isServers = state.selected === SERVERS_ID;
  const hasSel = isServers || (state.selected != null && state.sessions.has(state.selected));
  const fileView = !!state.openFile;
  document.body.classList.toggle('viewing', hasSel || fileView);
  // 상단 세션 동작 버튼(중단/리셋/종료)은 실제 세션을 볼 때만 노출(서버 현황 페이지에선 숨김)
  document.querySelectorAll('.tb-sess').forEach((b) => b.classList.toggle('hidden', !hasSel || isServers));
  // 위험 모드 상태를 ⋮ 메뉴 항목에 반영(다른 기기 토글로도 바뀔 수 있어 매 렌더마다).
  const dgItem = $('tb-danger');
  if (dgItem) {
    dgItem.classList.toggle('danger-on', state.danger);
    dgItem.classList.toggle('hidden', state.restricted); // 전역 설정 — 샌드박스 계정에겐 숨김
    const hint = $('tb-danger-hint');
    if (hint) hint.textContent = state.danger ? 'ON — 자동 실행 중' : 'OFF — 매번 확인';
  }
  // 보조 서버(LAN 전용)도 샌드박스 계정에겐 의미 없고 전역 자원이라 숨긴다
  $('aux-btn')?.classList.toggle('hidden', state.restricted);
  $('tb-restart')?.classList.toggle('hidden', state.restricted); // 서버 전체 재기동 — 샌드박스 계정에겐 숨김
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

  // 목록 맨 위 고정: "서버 현황" — 로컬에서 돌고 있는 서버들의 실행 상태 페이지(세션 아님).
  // 샌드박스 계정(동료)에게는 숨긴다 — PC 전체 정보/프로세스 종료는 관리자 전용(API 도 403).
  if (!state.restricted) {
    const srv = document.createElement('div');
    srv.className = 'item srv-nav' + (state.selected === SERVERS_ID ? ' active' : '');
    srv.onclick = () => selectSession(SERVERS_ID);
    srv.innerHTML = `
      <div class="row">
        <span class="title">🖥️ 서버 현황</span>
      </div>
      <div class="cwd">로컬에서 돌고 있는 서버</div>`;
    list.appendChild(srv);
  } else if (state.selected === SERVERS_ID) {
    // 혹시 열린 채로 제한이 내려오면 빈 화면으로 되돌린다
    state.selected = null;
  }

  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'item' + (s.id === state.selected ? ' active' : '');
    el.onclick = () => selectSession(s.id);
    // 더블클릭: 이 세션의 작업 폴더를 파일 탭으로 바로 연다
    el.ondblclick = () => { selectSession(s.id); setSideTab('files'); };
    // 승인 대기면 목록에서 바로 허가/거부
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
        ${contextRing(s)}
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
        <button class="qa-btn qa-copy" id="qa-copy" title="이 대화를 복사해 같은 폴더로 새 세션을 열고 이어가기(API가 느려질 때 갈아타기)">📋</button>
        <button class="qa-btn qa-compact" id="qa-compact" title="컨텍스트 압축(/compact) — 이전 대화를 요약해 토큰 재독 비용을 줄임">CPT</button>
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
  // 자동 높이: 내용에 맞춰 늘어나 스크롤바가 생기지 않는다(최대 높이는 CSS max-height).
  const autoGrow = () => {
    prompt.style.height = 'auto';
    const h = Math.min(prompt.scrollHeight, 220);
    prompt.style.height = h + 'px';
    prompt.classList.toggle('overgrow', prompt.scrollHeight > 220); // 한계 초과 시에만 내부 스크롤
  };
  prompt.addEventListener('input', () => { state.drafts.set(s.id, prompt.value); autoGrow(); });
  if (prompt.value) autoGrow(); // 복원된 초안에도 맞춤

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
  // 복사/인계: 이 대화를 클립보드에 복사하고, 같은 폴더로 새 세션을 열어 이어간다
  // (s 는 셸 생성 시점 스냅샷 — WS/폴링이 객체를 갈아끼우므로 누를 때 최신 객체를 다시 꺼낸다)
  $('qa-copy').onclick = () => copyAndMigrate(state.sessions.get(s.id) || s);
  // CPT: 이 세션 컨텍스트를 지금 압축(/compact)
  $('qa-compact').onclick = () => {
    if (!confirm('이 세션의 이전 대화를 지금 압축할까요?\n(요약본으로 줄여 토큰 재독 비용을 낮춥니다)')) return;
    api('POST', `/sessions/${s.id}/compact`).catch(showErr);
  };
}

// 동적 영역: 머리말/승인·질문/로그/위험버튼 상태 — 입력창은 건드리지 않는다.
function updateDetailDynamic(s) {
  // 머리말(제목·상태 배지·🔔 알림 버튼)
  $('detail-head').innerHTML = `
    <span class="title">${esc(s.title)}</span>
    ${contextRing(s)}
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

  // 작업 중이면 로그 맨 아래에 CLI 스타일 스피너(✻ 궁리하는 중…)를 붙인다.
  // 주의: 이 단어들은 SDK 가 주는 게 아니라 CLI 처럼 프런트가 뽑는 장식 문구다.
  if (s.status === 'thinking' || s.status === 'starting') {
    const line = document.createElement('div');
    line.className = 'spin-line';
    line.innerHTML = `<span class="spin-star">✻</span><span class="spin-word"></span><span class="spin-elapsed"></span>`;
    log.appendChild(line);
    tickSpinner(line, s);
    startSpinnerTimer();
  }
}

// ---------- 작업중 스피너 ----------
// 기본: vocab.js 의 SPIN_VOCAB(고급 영어 어휘+뜻)을 8초마다 돌려 보여줌 — 기다리는 동안 단어 공부.
// vocab.js 로드 실패 시 아래 한국어 장식 문구로 폴백.
const SPIN_WORDS = [
  '궁리하는 중', '골똘히 생각하는 중', '계획을 꾸미는 중', '코드를 읽는 중',
  '뚝딱거리는 중', '조사하는 중', '머리를 굴리는 중', '실마리를 찾는 중',
  '요모조모 살피는 중', '가닥을 잡는 중', '두드려 보는 중', '차근차근 짚는 중',
];
// 세션마다 단어 순서가 달라지게 하는 간단한 해시(장식용이라 충돌 무관).
function spinHash(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}
// 스피너 한 틱: 어휘(8초마다 교체)와 경과 시간(마지막 스트림 활동 이후)을 갱신.
// 단어 인덱스는 벽시계 기준 — updatedAt 기준으로 하면 스트림이 흐르는 동안 계속 0으로
// 리셋돼 첫 단어만 나온다(실제로 그랬다). 경과 시간 표시는 침묵 감지용이라 그대로 둔다.
function tickSpinner(line, s) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 1000));
  const el = line.querySelector('.spin-word');
  const idx = spinHash(s.id) + Math.floor(Date.now() / 8000);
  if (typeof SPIN_VOCAB !== 'undefined' && SPIN_VOCAB.length) {
    const [w, m] = SPIN_VOCAB[idx % SPIN_VOCAB.length];
    el.innerHTML = `<b class="spin-en">${w}</b> — ${m}`;   // 우리 정적 목록이라 escape 불필요
  } else {
    el.textContent = SPIN_WORDS[idx % SPIN_WORDS.length] + '…';
  }
  line.querySelector('.spin-elapsed').textContent = sec >= 5 ? `(${sec}초)` : '';
}
// 재렌더 없이도 시간이 흐르게 1초 타이머로 스피너만 갱신. 스피너가 사라지면 스스로 멈춘다.
let spinTimer = null;
function startSpinnerTimer() {
  if (spinTimer) return;
  spinTimer = setInterval(() => {
    const line = document.querySelector('#log .spin-line');
    const s = state.selected ? state.sessions.get(state.selected) : null;
    if (!line || !s) { clearInterval(spinTimer); spinTimer = null; return; }
    tickSpinner(line, s);
  }, 1000);
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

// ---------- 파일 탐색기(사이드 탭) + 파일 탭 패널 ----------
// VS Code 식: 사이드바 [세션|파일] 탭에서 파일을 고르면 대화 화면 옆 탭(패널)으로
// 내용이 열린다. 코드는 텍스트로, 이미지/영상/음성은 브라우저에서 재생, 전부 다운로드 가능.
const TEXT_EXT = new Set(['txt','md','markdown','js','mjs','cjs','ts','tsx','jsx','json','css','html','htm','py','ps1','psm1','bat','cmd','sh','yml','yaml','toml','ini','cfg','conf','log','csv','tsv','xml','sql','java','c','h','cpp','hpp','cs','go','rs','rb','php','ahk','vb','env','example','gitignore','lock']);
const IMG_EXT = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif']);
// 오피스 문서 — 서버가 LibreOffice 로 PDF 변환해 보여준다 (src/convert.ts 의 CONVERTIBLE_EXT 와 짝)
const OFFICE_EXT = new Set(['pptx','ppt','odp','docx','doc','odt','rtf','xlsx','xls','ods']);
const VID_EXT = new Set(['mp4','webm','mov','m4v']);
const AUD_EXT = new Set(['mp3','wav','ogg','m4a','flac','aac']);

function extOf(name) { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
// <img>/<video> 는 Authorization 헤더를 못 보내므로 토큰을 쿼리로 싣는다(서버가 ?token= 허용).
function fileUrl(path, download) {
  return '/api/file?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(state.token) + (download ? '&download=1' : '');
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// --- 사이드바 탭 전환 ---
// 파일 트리는 "지금 선택된 세션의 작업 폴더"를 뿌리로 연다. 같은 세션 안에서 폴더를
// 옮겨 다닌 위치(fileDir)는 유지하되, 다른 세션으로 바뀌면 그 세션의 cwd 로 다시 연다.
// 세션이 선택돼 있으면 그 cwd 가 트리의 하한 — 각 프로젝트는 자기 폴더만 보이고
// 상위(다른 프로젝트들)로는 못 올라간다. (세션 미선택 시엔 계정 루트 기준)
function treeRoot() {
  const s = state.selected ? state.sessions.get(state.selected) : null;
  return s?.cwd || null;
}
function normPath(p) { return (p || '').replace(/[\\/]+$/, '').toLowerCase(); }
function underTreeRoot(p) {
  const r = treeRoot();
  if (!r) return true;
  const np = normPath(p), nr = normPath(r);
  return np === nr || np.startsWith(nr + '\\') || np.startsWith(nr + '/');
}
async function loadTreeForCurrent() {
  const s = state.selected ? state.sessions.get(state.selected) : null;
  const changed = state.fileTreeFor !== state.selected;
  state.fileTreeFor = state.selected;
  let start = !changed && state.fileDir ? state.fileDir : '';
  if (start && !underTreeRoot(start)) start = ''; // 이전에 프로젝트 밖을 보고 있었으면 cwd 로 재루트
  if (!start) start = s?.cwd || (await getStartDir());
  loadTree(start);
}
function setSideTab(tab) {
  state.sideTab = tab;
  $('side-tab-sessions').classList.toggle('on', tab === 'sessions');
  $('side-tab-files').classList.toggle('on', tab === 'files');
  $('list').classList.toggle('hidden', tab !== 'sessions');
  $('file-tree').classList.toggle('hidden', tab !== 'files');
  if (tab === 'files') void loadTreeForCurrent();
}
$('side-tab-sessions').onclick = () => setSideTab('sessions');
$('side-tab-files').onclick = () => setSideTab('files');
$('files-btn').onclick = () => setSideTab('files');

// --- 파일 트리(사이드바) ---
// VS Code 식 트리: 폴더를 클릭하면 바로 아래에 들여쓰기로 펼쳐지고, 다시 클릭하면 접힌다.
// 펼친 폴더 목록(expanded)은 유지돼 세션 전환 후 돌아와도 상태가 남는다.
function treeDirRow(container, dirPath, depth) {
  const name = dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath;
  const row = document.createElement('div');
  row.className = 'tree-row dir';
  row.style.paddingLeft = 10 + depth * 14 + 'px';
  const isOpen = state.treeOpen.has(dirPath);
  row.innerHTML = `<span class="tree-name" title="${esc(dirPath)}"><span class="tree-arrow">${isOpen ? '▾' : '▸'}</span> 📁 ${esc(name)}</span>`;
  const kids = document.createElement('div'); // 자식들이 렌더될 컨테이너(접으면 비움)
  row.onclick = async () => {
    const arrow = row.querySelector('.tree-arrow');
    if (state.treeOpen.has(dirPath)) {
      state.treeOpen.delete(dirPath);
      kids.innerHTML = '';
      arrow.textContent = '▸';
    } else {
      state.treeOpen.add(dirPath);
      arrow.textContent = '▾';
      await renderTreeChildren(kids, dirPath, depth + 1);
    }
  };
  container.appendChild(row);
  container.appendChild(kids);
  if (isOpen) void renderTreeChildren(kids, dirPath, depth + 1);
}
function treeFileRow(container, f, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row file' + (state.openFile && state.openFile.path === f.path ? ' active' : '');
  row.style.paddingLeft = 10 + depth * 14 + 'px';
  row.innerHTML = `<span class="tree-name" title="${esc(f.path)}">📄 ${esc(f.name)}</span><span class="file-size">${fmtSize(f.size)}</span>`;
  row.onclick = () => openFileTab(f);
  container.appendChild(row);
}
async function renderTreeChildren(container, path, depth) {
  try {
    const b = await api('GET', '/files?path=' + encodeURIComponent(path || ''));
    container.innerHTML = '';
    for (const d of b.dirs) treeDirRow(container, d, depth);
    for (const f of (b.files || [])) treeFileRow(container, f, depth);
    if (b.error) {
      const e = document.createElement('div');
      e.className = 'tree-row';
      e.style.paddingLeft = 10 + depth * 14 + 'px';
      e.textContent = '열 수 없음: ' + b.error;
      container.appendChild(e);
    }
  } catch (e) {
    container.innerHTML = `<div class="tree-row">오류: ${esc(e.message)}</div>`;
  }
}
async function loadTree(path) {
  const tree = $('file-tree');
  // 세션 프로젝트 폴더 밖(또는 빈 경로)은 전부 cwd 로 스냅 — 상위 프로젝트 목록이 안 보이게
  const lower = treeRoot();
  if (lower && !underTreeRoot(path)) path = lower;
  try {
    const b = await api('GET', '/files?path=' + encodeURIComponent(path || ''));
    state.fileDir = b.isRoot ? '' : b.path;
    tree.innerHTML = '';
    const here = document.createElement('div');
    here.className = 'tree-here';
    here.textContent = b.isRoot ? '드라이브 선택' : b.path;
    here.title = b.path || '';
    tree.appendChild(here);
    if (b.parent !== null && (!lower || (underTreeRoot(b.parent) && normPath(b.path) !== normPath(lower)))) {
      const up = document.createElement('div');
      up.className = 'tree-row up';
      up.textContent = '⬆ 상위로';
      up.onclick = () => loadTree(b.parent);
      tree.appendChild(up);
    }
    const body = document.createElement('div');
    tree.appendChild(body);
    for (const d of b.dirs) treeDirRow(body, d, 0);
    for (const f of (b.files || [])) treeFileRow(body, f, 0);
    if (b.error) { const e = document.createElement('div'); e.className = 'tree-row'; e.textContent = '열 수 없음: ' + b.error; body.appendChild(e); }
  } catch (e) {
    tree.innerHTML = `<div class="tree-row">오류: ${esc(e.message)}</div>`;
  }
}

// --- 파일 패널(대화 옆 분할 화면) ---
// 대화와 파일 내용을 나란히 띄우고, 가운데 구분선(splitter) 드래그로 폭을 조절한다.
function updatePaneVisibility() {
  const open = !!state.openFile;
  $('splitter').classList.toggle('hidden', !open);
  $('file-pane').classList.toggle('hidden', !open);
  if (open) {
    const saved = parseInt(localStorage.getItem('sm_filew') || '', 10);
    $('file-pane').style.width =
      (saved > 200 ? saved : Math.max(300, Math.round(window.innerWidth * 0.42))) + 'px';
  }
}
function closeFileTab() {
  state.openFile = null;
  updatePaneVisibility();
  render();
}

function openFileTab(f) {
  state.openFile = f;
  updatePaneVisibility();
  renderFilePane(f);
  // 트리에서 열린 파일 강조 갱신
  document.querySelectorAll('#file-tree .tree-row.file').forEach((r) => {
    r.classList.toggle('active', r.querySelector('.tree-name')?.title === f.path);
  });
  render(); // 모바일 마스터-디테일(viewing) 갱신
}

// 구분선 드래그 — pointer capture 를 써서 iframe(PDF) 위로 지나가도 이벤트를 놓치지 않는다.
// onMove 는 포인터 x 좌표를 받아 폭을 적용한다.
function attachSplitter(sp, onMove) {
  let dragging = false;
  sp.addEventListener('pointerdown', (e) => {
    dragging = true;
    sp.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  sp.addEventListener('pointermove', (e) => { if (dragging) onMove(e.clientX); });
  sp.addEventListener('pointerup', () => { dragging = false; });
}
// 파일 패널(오른쪽) 폭
attachSplitter($('splitter'), (x) => {
  const col = $('splitter').parentElement.getBoundingClientRect();
  const w = Math.max(260, Math.min(col.right - x, col.width - 320)); // 양쪽 최소 폭 보장
  $('file-pane').style.width = w + 'px';
  localStorage.setItem('sm_filew', String(w));
});
// 사이드바(왼쪽) 폭
attachSplitter($('side-splitter'), (x) => {
  const layout = $('side').parentElement.getBoundingClientRect();
  const w = Math.max(170, Math.min(x - layout.left, Math.round(layout.width * 0.6)));
  $('side').style.width = w + 'px';
  localStorage.setItem('sm_sidew', String(w));
});
// 저장된 사이드바 폭 복원
{
  const saved = parseInt(localStorage.getItem('sm_sidew') || '', 10);
  if (saved >= 170) $('side').style.width = saved + 'px';
}

function renderFilePane(f) {
  const pane = $('file-pane');
  pane.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'file-pane-head';
  head.innerHTML = `<span class="file-pane-title" title="${esc(f.path)}">📄 ${esc(f.name)}</span>`;
  const dl = document.createElement('button');
  dl.className = 'ghost';
  dl.textContent = '⬇';
  dl.title = '다운로드';
  dl.onclick = () => {
    const a = document.createElement('a');
    a.href = fileUrl(f.path, true);
    a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  head.appendChild(dl);
  const x = document.createElement('button');
  x.className = 'ghost';
  x.textContent = '✕';
  x.title = '파일 패널 닫기';
  x.onclick = closeFileTab;
  head.appendChild(x);
  pane.appendChild(head);
  const pathBar = document.createElement('div');
  pathBar.className = 'file-pane-pathbar';
  pathBar.textContent = f.path;
  pathBar.title = f.path;
  pane.appendChild(pathBar);
  const body = document.createElement('div');
  body.className = 'file-pane-body';
  pane.appendChild(body);

  const ext = extOf(f.name);
  const url = fileUrl(f.path);
  if (IMG_EXT.has(ext)) { const img = new Image(); img.className = 'viewer-media'; img.src = url; body.appendChild(img); return; }
  if (VID_EXT.has(ext)) { const v = document.createElement('video'); v.controls = true; v.className = 'viewer-media'; v.src = url; body.appendChild(v); return; }
  if (AUD_EXT.has(ext)) { const a = document.createElement('audio'); a.controls = true; a.src = url; a.style.width = '100%'; body.appendChild(a); return; }
  if (ext === 'pdf') { const fr = document.createElement('iframe'); fr.className = 'viewer-frame'; fr.src = url; body.appendChild(fr); return; }
  // 오피스 문서 — 서버가 PDF 로 변환해 준다. 첫 변환은 수 초 걸리므로 진행 표시 후 교체.
  if (OFFICE_EXT.has(ext)) {
    const msg = document.createElement('div');
    msg.className = 'viewer-converting';
    msg.textContent = '📄 PDF로 변환 중… (첫 열람은 수 초 걸립니다)';
    body.appendChild(msg);
    const pvUrl = '/api/preview?path=' + encodeURIComponent(f.path) + '&token=' + encodeURIComponent(state.token);
    fetch(pvUrl)
      .then(async (r) => {
        if (!r.ok) {
          let detail = 'HTTP ' + r.status;
          try { detail = (await r.json()).error || detail; } catch { /* JSON 아님 */ }
          throw new Error(detail);
        }
        return r.blob();
      })
      .then((blob) => {
        if (state.openFile?.path !== f.path) return; // 기다리는 동안 다른 파일을 열었으면 무시
        const fr = document.createElement('iframe');
        fr.className = 'viewer-frame';
        fr.src = URL.createObjectURL(blob);
        body.innerHTML = '';
        body.appendChild(fr);
        // pptx 는 PDF 가 영상을 정지 포스터로만 보여준다 — 내장 영상을 추출해 아래에 재생 가능하게 붙인다
        if (ext === 'pptx') {
          fetch('/api/preview-media?path=' + encodeURIComponent(f.path) + '&token=' + encodeURIComponent(state.token))
            .then((r) => (r.ok ? r.json() : { videos: [] }))
            .then(({ videos }) => {
              if (!videos?.length || state.openFile?.path !== f.path) return;
              const sec = document.createElement('div');
              sec.className = 'viewer-videos';
              sec.innerHTML = `<div class="viewer-videos-title">🎬 슬라이드 영상 ${videos.length}개 (PDF에선 정지화면)</div>`;
              for (const v of videos) {
                const card = document.createElement('div');
                card.className = 'viewer-video-card';
                const label = document.createElement('div');
                label.className = 'viewer-video-label';
                label.textContent = `슬라이드 ${v.slide}`;
                const vid = document.createElement('video');
                vid.controls = true;
                vid.playsInline = true;
                vid.preload = 'metadata';
                vid.src = '/api/preview-media/file?path=' + encodeURIComponent(f.path) +
                  '&name=' + encodeURIComponent(v.name) + '&token=' + encodeURIComponent(state.token);
                card.appendChild(label); card.appendChild(vid);
                sec.appendChild(card);
              }
              body.appendChild(sec);
            })
            .catch(() => { /* 영상 추출 실패는 치명적이지 않음 — PDF 만 보여준다 */ });
        }
      })
      .catch((e) => { msg.textContent = '변환 실패: ' + e.message + ' — ⬇ 다운로드로 여세요.'; });
    return;
  }
  // 코드/텍스트 — 알려진 텍스트 확장자, 또는 모르는 확장자라도 512KB 이하면 텍스트로 시도
  if (TEXT_EXT.has(ext) || f.size <= 512 * 1024) {
    if (f.size > 2 * 1024 * 1024) { body.textContent = '텍스트가 너무 큽니다(2MB 초과). ⬇ 다운로드로 여세요.'; return; }
    const pre = document.createElement('pre');
    pre.className = 'viewer-code';
    pre.textContent = '불러오는 중…';
    body.appendChild(pre);
    fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then((t) => { pre.textContent = t; })
      .catch((e) => { pre.textContent = '열 수 없음: ' + e.message; });
    return;
  }
  body.textContent = '미리보기를 지원하지 않는 형식입니다. ⬇ 다운로드로 여세요.';
}
$('aux-static-start').onclick = () => auxAction('static', 'start');
$('aux-static-stop').onclick = () => auxAction('static', 'stop');
$('aux-upload-start').onclick = () => auxAction('upload', 'start');
$('aux-upload-stop').onclick = () => auxAction('upload', 'stop');

// ---------- 응답 지연 진단 ----------
// 진단 버튼 → 서버가 컨텍스트/모델시간/연결오류를 분석해 판정+권장 대응을 준다.
// 대응(압축/재시작/중단)은 여기 버튼으로 사용자가 직접 눌러 실행한다(자동 실행 아님).
let diagSessionId = null; // 지금 진단 모달이 보고 있는 세션 id
async function openDiagnose(id) {
  diagSessionId = id;
  $('diag-err').textContent = '';
  $('diag-body').innerHTML = '<div class="empty">진단 중…</div>';
  $('diag-modal').classList.remove('hidden');
  await runDiagnose();
}
async function runDiagnose() {
  const id = diagSessionId;
  if (!id) return;
  $('diag-err').textContent = '';
  try {
    const d = await api('GET', `/sessions/${id}/diagnose`);
    renderDiagnosis(d.diagnosis);
  } catch (e) {
    $('diag-body').innerHTML = '';
    $('diag-err').textContent = e.message || String(e);
  }
}
function renderDiagnosis(d) {
  const s = state.sessions.get(diagSessionId);
  const k = (n) => Math.round(n / 1000) + 'k';
  const secs = (n) => (n < 0 ? '-' : (n / 1000).toFixed(0) + 's');
  const sevLabel = { crit: '무거움', warn: '보통', ok: '양호' }[d.severity] || d.severity;
  const m = d.metrics;
  const findings = d.findings
    .map((f) => `<li class="diag-f diag-${f.level}">${esc(f.text)}</li>`)
    .join('');
  const metricsRow =
    `상주 ${k(m.ctx)}/${k(m.max)}` +
    (m.compactAt ? ` · 자동압축 ${k(m.compactAt)}` : '') +
    ` · 모델 최근 ${secs(m.lastApiMs)}/중앙 ${secs(m.medianApiMs)}/최대 ${secs(m.maxApiMs)}` +
    ` · 캐시 ${m.cacheHitPct}%` +
    ` · 연결오류 ${m.retryCount}회 · 표본 ${m.turns}턴`;
  const actions = d.actions
    .map((a) => `<button class="diag-act diag-act-${a.kind}" data-kind="${a.kind}">${esc(a.label)}${a.note ? `<span class="diag-act-note">${esc(a.note)}</span>` : ''}</button>`)
    .join('');
  $('diag-body').innerHTML = `
    <div class="diag-headline diag-sev-${d.severity}"><span class="diag-badge">${esc(sevLabel)}</span>${esc(d.headline)}</div>
    <ul class="diag-list">${findings || '<li class="diag-f diag-ok">소견 없음</li>'}</ul>
    <div class="diag-metrics">${esc(metricsRow)}</div>
    ${actions ? `<div class="diag-actions-label">권장 대응 (직접 실행)</div><div class="diag-actions">${actions}</div>` : '<div class="diag-metrics">권장 대응: 없음 (양호)</div>'}`;
  // 액션 버튼 연결
  $('diag-body').querySelectorAll('.diag-act').forEach((btn) => {
    btn.onclick = () => runDiagAction(btn.dataset.kind, s);
  });
}
async function runDiagAction(kind, s) {
  if (!s) return;
  try {
    if (kind === 'compact') {
      if (!confirm('지금 컨텍스트를 압축(/compact)할까요?')) return;
      await api('POST', `/sessions/${s.id}/compact`);
    } else if (kind === 'interrupt') {
      await api('POST', `/sessions/${s.id}/interrupt`);
    } else if (kind === 'restart') {
      $('diag-modal').classList.add('hidden'); // resetSession 이 자체 확인창을 띄운다
      await resetSession(s);
      return;
    }
    $('diag-modal').classList.add('hidden');
  } catch (e) {
    $('diag-err').textContent = e.message || String(e);
  }
}
$('diag-close').onclick = () => { $('diag-modal').classList.add('hidden'); diagSessionId = null; };
$('diag-refresh').onclick = () => runDiagnose();

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
