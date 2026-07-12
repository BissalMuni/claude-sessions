// 보조 서버(정적 파일 서버 + 파일 업로드 서버)를 claude-sessions 프로세스 안에서
// 폴더를 지정해 켜고 끈다. 각자 별도 포트에 바인딩(0.0.0.0, LAN). 토글은 API/WS 로 제어.
//
// 보안: 시작/정지 제어는 claude-sessions 토큰으로 보호되고(api.ts), 대상 폴더는 요청
// 계정의 root 서브트리로 제한된다(샌드박스). 서버 자체는 LAN 무인증(켜져 있는 동안만
// 노출) — python -m http.server 를 대체하는 '열고 닫는' 임시 공유용이다.

import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { AuxOne, AuxStatus } from './types.js';

export type AuxKind = 'static' | 'upload';

interface AuxInstance {
  server: Server;
  dir: string;
  port: number;
}

const DEFAULT_PORT: Record<AuxKind, number> = { static: 8790, upload: 8791 };
const instances: Record<AuxKind, AuxInstance | null> = { static: null, upload: null };

export function auxStatus(): AuxStatus {
  const one = (k: AuxKind): AuxOne => {
    const i = instances[k];
    return i ? { running: true, dir: i.dir, port: i.port } : { running: false };
  };
  return { static: one('static'), upload: one('upload') };
}

/** 보조 서버 시작. 이미 켜져 있으면 먼저 끄고 새 폴더/포트로 다시 연다. */
export async function startAux(kind: AuxKind, dir: string, port?: number): Promise<AuxOne> {
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error('폴더가 아닙니다: ' + abs);
  }
  await stopAux(kind);
  const p = port && port > 0 ? port : DEFAULT_PORT[kind];
  const handler = kind === 'static' ? makeStaticHandler(abs) : makeUploadHandler(abs);
  const server = createServer(handler);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(p, '0.0.0.0', () => {
      server.removeListener('error', rej);
      res();
    });
  });
  instances[kind] = { server, dir: abs, port: p };
  return { running: true, dir: abs, port: p };
}

/** 보조 서버 정지. 안 켜져 있으면 무시. */
export async function stopAux(kind: AuxKind): Promise<void> {
  const i = instances[kind];
  if (!i) return;
  instances[kind] = null;
  await new Promise<void>((res) => i.server.close(() => res()));
}

/** 프로세스 종료 시 둘 다 정리. */
export async function stopAllAux(): Promise<void> {
  await Promise.all([stopAux('static'), stopAux('upload')]);
}

// ---------- 정적 파일 서버 (디렉터리 목록 + 파일 전송) ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// root 아래로만 떨어지도록 URL 경로를 안전하게 합친다. 탈출 시 null.
function safeResolve(root: string, urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const target = resolve(root, rel);
  const withSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(withSep)) return null;
  return target;
}

function makeStaticHandler(root: string) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const target = safeResolve(root, req.url || '/');
    if (target === null) {
      res.writeHead(400).end('bad path');
      return;
    }
    let st;
    try {
      st = statSync(target);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(target).sort((a, b) => a.localeCompare(b));
      } catch (e) {
        res.writeHead(500).end(String(e));
        return;
      }
      const relRoot = target.slice(root.length).replace(/\\/g, '/') || '/';
      const rows = entries
        .map((name) => {
          const isDir = (() => {
            try {
              return statSync(join(target, name)).isDirectory();
            } catch {
              return false;
            }
          })();
          const href = (relRoot === '/' ? '' : relRoot) + '/' + encodeURIComponent(name) + (isDir ? '/' : '');
          return `<li><a href="${esc(href)}">${esc(name)}${isDir ? '/' : ''}</a></li>`;
        })
        .join('\n');
      const up = relRoot === '/' ? '' : '<li><a href="../">../</a></li>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(relRoot)}</title>` +
          `<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:1.5rem auto;padding:0 1rem;line-height:1.8}a{text-decoration:none}li{list-style:none}</style>` +
          `<h2>📁 ${esc(relRoot)}</h2><ul>${up}${rows}</ul>`,
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
    createReadStream(target).pipe(res);
  };
}

// ---------- 업로드 서버 (폼 + POST 저장, 경로탈출 방어) ----------

const UPLOAD_PAGE = (root: string) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>업로드</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.6}
label{display:block;margin:.8rem 0 .3rem;font-weight:600}input[type=text]{width:100%;padding:.5rem;box-sizing:border-box;font-size:1rem}
button{padding:.6rem 1.2rem;font-size:1rem;cursor:pointer}#log{white-space:pre-wrap;background:#f5f5f5;padding:.8rem;border-radius:6px;margin-top:1rem;font-family:monospace;font-size:.85rem}
small{color:#666}</style></head><body>
<h1>파일 업로드</h1><p><small>저장 위치: <code>${esc(root)}</code></small></p>
<label>하위 폴더 (선택, 예: sub/dir)</label><input id="dest" type="text" placeholder="비우면 위 폴더에 바로 저장">
<div><label>파일 (여러 개 가능)</label><input id="files" type="file" multiple></div>
<div><label>또는 폴더 통째로</label><input id="folder" type="file" webkitdirectory directory multiple></div>
<p><button id="go">업로드</button></p><div id="log"></div>
<script>
const log=m=>{document.getElementById('log').textContent+=m+"\\n";};
document.getElementById('go').onclick=async()=>{
 const dest=document.getElementById('dest').value.trim();
 const all=Array.from(document.getElementById('files').files).concat(Array.from(document.getElementById('folder').files));
 if(!all.length){log('선택된 파일이 없습니다.');return;}
 log('총 '+all.length+'개 업로드...');let ok=0,fail=0;
 for(const file of all){
  const rel=file.webkitRelativePath&&file.webkitRelativePath.length?file.webkitRelativePath:file.name;
  const full=dest?(dest.replace(/\\/+$/,'')+'/'+rel):rel;
  try{const r=await fetch('/upload',{method:'POST',headers:{'X-Rel-Path':encodeURIComponent(full)},body:file});
   if(r.ok){ok++;log('OK  '+full);}else{fail++;log('실패('+r.status+') '+full+' : '+await r.text());}}
  catch(e){fail++;log('에러 '+full+' : '+e);}}
 log('완료. 성공 '+ok+', 실패 '+fail);
};
</script></body></html>`;

// rel 을 root 아래 안전 경로로. 드라이브문자/.. 차단. 실패 시 null.
function safeJoinUpload(root: string, rel: string): string | null {
  let r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (r.length >= 2 && r[1] === ':') r = r.slice(2).replace(/^\/+/, '');
  const parts: string[] = [];
  for (let seg of r.split('/')) {
    seg = seg.trim();
    if (seg === '' || seg === '.') continue;
    if (seg === '..' || seg.includes('\x00')) return null;
    parts.push(seg);
  }
  if (!parts.length) return null;
  const dest = resolve(root, ...parts);
  const withSep = root.endsWith(sep) ? root : root + sep;
  if (!dest.startsWith(withSep)) return null;
  return dest;
}

function makeUploadHandler(root: string) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UPLOAD_PAGE(root));
      return;
    }
    if (req.method !== 'POST' || (req.url || '') !== '/upload') {
      res.writeHead(404).end('not found');
      return;
    }
    const relHeader = req.headers['x-rel-path'];
    const rel = typeof relHeader === 'string' ? decodeURIComponent(relHeader) : '';
    if (!rel) {
      res.writeHead(400).end('X-Rel-Path 없음');
      return;
    }
    const dest = safeJoinUpload(root, rel);
    if (!dest) {
      res.writeHead(400).end('잘못된 경로');
      return;
    }
    try {
      mkdirSync(join(dest, '..'), { recursive: true });
    } catch {
      /* 상위 폴더 생성 실패는 아래 write 에서 잡힘 */
    }
    const out = createWriteStream(dest);
    req.pipe(out);
    out.on('finish', () => res.writeHead(200).end('saved: ' + dest.slice(root.length)));
    out.on('error', (e) => res.writeHead(500).end('쓰기 실패: ' + e.message));
  };
}
