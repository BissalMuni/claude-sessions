// 폰 클라이언트 — 토큰 인증, WebSocket 수신, 세션 목록/상세/승인/명령

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('sm_token') || '',
  sessions: new Map(), // id -> SessionView
  selected: null, // 선택된 세션 id
  ws: null,
  drafts: new Map(), // sessionId -> 입력 중인(아직 전송 안 한) 텍스트
};

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
}
$('token-btn').onclick = () => {
  const t = $('token-input').value.trim();
  if (!t) return;
  state.token = t;
  localStorage.setItem('sm_token', t);
  enterApp();
};
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-btn').click(); });
$('logout-btn').onclick = () => {
  localStorage.removeItem('sm_token');
  state.token = '';
  if (state.ws) state.ws.close();
  showGate('');
};

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
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => $('conn').classList.add('on');
  ws.onclose = (e) => {
    $('conn').classList.remove('on');
    if (e.code === 4001) { showGate('토큰이 올바르지 않습니다.'); return; }
    setTimeout(() => { if (state.token) connect(); }, 1500); // 자동 재연결
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

function handleEvent(ev) {
  if (ev.type === 'snapshot') {
    state.sessions.clear();
    for (const s of ev.sessions) state.sessions.set(s.id, s);
  } else if (ev.type === 'session_update') {
    state.sessions.set(ev.session.id, ev.session);
  } else if (ev.type === 'session_removed') {
    state.sessions.delete(ev.sessionId);
    state.drafts.delete(ev.sessionId);
    if (state.selected === ev.sessionId) state.selected = null;
  }
  render();
}

// ---------- 렌더 ----------
const STATUS_KO = {
  starting: '시작중', idle: '대기', thinking: '작업중',
  awaiting_permission: '승인대기', done: '완료', error: '오류',
};

function render() {
  // 재렌더 전에 입력창 포커스/커서 위치를 기억해 둔다 (이벤트 도중 타이핑 끊김 방지)
  const active = document.activeElement;
  const promptFocused = !!active && active.id === 'prompt';
  const caretStart = promptFocused ? active.selectionStart : null;
  const caretEnd = promptFocused ? active.selectionEnd : null;

  // 폰 마스터-디테일: 유효한 세션이 선택됐을 때만 상세 화면을 보인다
  const hasSel = state.selected != null && state.sessions.has(state.selected);
  document.body.classList.toggle('viewing', hasSel);
  renderList();
  renderDetail();

  // 입력 중이었다면 포커스와 커서 위치를 복원한다
  if (promptFocused) {
    const p = $('prompt');
    if (p) {
      p.focus();
      if (caretStart != null) p.setSelectionRange(caretStart, caretEnd);
    }
  }
}

function renderList() {
  const list = $('list');
  const sessions = [...state.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  list.innerHTML = '';
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'item' + (s.id === state.selected ? ' active' : '');
    el.onclick = () => { state.selected = s.id; render(); };
    el.innerHTML = `
      <div class="row">
        <span class="title">${esc(s.title)}</span>
        <span class="badge ${s.status}">${STATUS_KO[s.status] || s.status}</span>
      </div>
      <div class="cwd">${esc(s.cwd)}</div>`;
    list.appendChild(el);
  }
}

function renderDetail() {
  const detail = $('detail');
  const s = state.selected ? state.sessions.get(state.selected) : null;
  if (!s) { detail.innerHTML = '<div class="empty">세션을 선택하거나 새로 만드세요.</div>'; return; }

  detail.innerHTML = `
    <div class="detail-head">
      <button class="ghost back-btn" id="d-back">◀ 목록</button>
      <span class="title">${esc(s.title)}</span>
      <span class="badge ${s.status}">${STATUS_KO[s.status] || s.status}</span>
      <div class="actions">
        <button class="ghost" id="d-interrupt">중단</button>
        <button class="ghost" id="d-remove">종료</button>
      </div>
    </div>
    ${s.pending ? renderPerm(s) : ''}
    <div class="log" id="log"></div>
    <div class="composer">
      <textarea id="prompt" placeholder="다음 명령을 입력…"></textarea>
      <button id="send">전송</button>
    </div>`;

  const log = $('log');
  for (const m of s.messages) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.kind;
    el.innerHTML = `<div class="who">${whoLabel(m.kind)}</div><div class="body">${esc(m.text)}</div>`;
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;

  $('d-back').onclick = () => { state.selected = null; render(); }; // 폰: 목록으로 복귀
  $('d-interrupt').onclick = () => api('POST', `/sessions/${s.id}/interrupt`).catch(showErr);
  $('d-remove').onclick = () => { if (confirm('이 세션을 종료할까요?')) api('DELETE', `/sessions/${s.id}`).catch(showErr); };

  // 입력 중이던 초안을 복원하고, 타이핑할 때마다 초안을 저장한다 (재렌더에도 보존)
  const prompt = $('prompt');
  prompt.value = state.drafts.get(s.id) || '';
  prompt.addEventListener('input', () => state.drafts.set(s.id, prompt.value));

  const send = () => {
    const text = prompt.value.trim();
    if (!text) return;
    api('POST', `/sessions/${s.id}/prompt`, { text }).then(() => {
      state.drafts.delete(s.id);
      prompt.value = '';
    }).catch(showErr);
  };
  $('send').onclick = send;
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  if (s.pending) {
    $('perm-yes').onclick = () => decide(s, 'yes');
    $('perm-no').onclick = () => decide(s, 'no');
  }
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

// ---------- 새 세션 모달 + 폴더 피커 ----------
async function loadPicker(path) {
  try {
    const b = await api('GET', '/browse?path=' + encodeURIComponent(path || ''));
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
    for (const d of b.dirs) {
      const row = document.createElement('div');
      row.className = 'picker-row';
      row.textContent = '📁 ' + d;
      row.onclick = () => loadPicker(d);
      list.appendChild(row);
    }
    if (b.error) { const e = document.createElement('div'); e.className = 'picker-row'; e.textContent = '열 수 없음: ' + b.error; list.appendChild(e); }
  } catch (e) { showErr(e); }
}
$('new-btn').onclick = () => { $('modal').classList.remove('hidden'); $('modal-err').textContent = ''; loadPicker(''); };
$('modal-cancel').onclick = () => $('modal').classList.add('hidden');
$('modal-create').onclick = () => {
  const cwd = $('cwd-input').value.trim();
  const title = $('title-input').value.trim();
  if (!cwd) { $('modal-err').textContent = '작업 폴더를 입력하세요.'; return; }
  api('POST', '/sessions', { cwd, title })
    .then((d) => { state.selected = d.session.id; $('modal').classList.add('hidden'); $('cwd-input').value = ''; $('title-input').value = ''; render(); })
    .catch((e) => { $('modal-err').textContent = e.message; });
};

// ---------- 유틸 ----------
function whoLabel(kind) {
  return { text: 'Claude', tool: '도구', result: '결과', system: '시스템', user: '나', error: '오류' }[kind] || kind;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function showErr(e) { alert(e.message || String(e)); }

// ---------- 시작 ----------
if (state.token) enterApp(); else showGate('');
