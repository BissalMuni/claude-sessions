# -*- coding: utf-8 -*-
"""
간단한 LAN 업로드 서버.
다른 PC(또는 폰) 브라우저에서 파일/폴더를 골라 올리면
coding 폴더 안의 '지정한 하위 폴더'에 폴더 구조를 유지한 채 저장한다.

- 저장 루트: CODING_ROOT (기본 c:/Users/minh0/Downloads/coding)
- 경로 탈출(..) / 절대경로 / 드라이브 문자 차단
- 하위 폴더는 웹 폼에서 지정 (비우면 coding 루트에 그대로)
"""
import os
import sys
import html
import posixpath
from urllib.parse import unquote
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CODING_ROOT = os.path.abspath(os.environ.get("CODING_ROOT", r"c:/Users/minh0/Downloads/coding"))
PORT = int(os.environ.get("PORT", "8000"))

PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coding 업로드</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.6}
 h1{font-size:1.3rem} label{display:block;margin:.8rem 0 .3rem;font-weight:600}
 input[type=text]{width:100%;padding:.5rem;box-sizing:border-box;font-size:1rem}
 .row{margin:1rem 0} button{padding:.6rem 1.2rem;font-size:1rem;cursor:pointer}
 #log{white-space:pre-wrap;background:#f5f5f5;padding:.8rem;border-radius:6px;margin-top:1rem;font-family:monospace;font-size:.85rem}
 small{color:#666}
</style></head><body>
<h1>coding 폴더로 업로드</h1>
<p><small>저장 루트: <code>%ROOT%</code></small></p>

<label>저장 위치 (coding 안의 하위 폴더, 예: <code>my-project</code>)</label>
<input id="dest" type="text" placeholder="비우면 coding 루트에 바로 저장">

<div class="row">
  <label>파일 선택 (여러 개 가능)</label>
  <input id="files" type="file" multiple>
</div>
<div class="row">
  <label>또는 폴더 통째로 선택 (구조 유지)</label>
  <input id="folder" type="file" webkitdirectory directory multiple>
</div>

<button id="go">업로드</button>
<div id="log"></div>

<script>
const log = (m)=>{document.getElementById('log').textContent += m + "\\n";};
document.getElementById('go').onclick = async ()=>{
  const dest = document.getElementById('dest').value.trim();
  const f1 = Array.from(document.getElementById('files').files);
  const f2 = Array.from(document.getElementById('folder').files);
  const all = f1.concat(f2);
  if(!all.length){ log('선택된 파일이 없습니다.'); return; }
  log('총 ' + all.length + '개 업로드 시작...');
  let ok=0, fail=0;
  for(const file of all){
    // 폴더 선택이면 webkitRelativePath(구조), 아니면 파일명만
    const rel = file.webkitRelativePath && file.webkitRelativePath.length ? file.webkitRelativePath : file.name;
    const full = dest ? (dest.replace(/\\/+$/,'') + '/' + rel) : rel;
    try{
      const res = await fetch('/upload', {
        method:'POST',
        headers:{'X-Rel-Path': encodeURIComponent(full)},
        body: file
      });
      if(res.ok){ ok++; log('OK  ' + full); }
      else { fail++; log('실패(' + res.status + ') ' + full + ' : ' + await res.text()); }
    }catch(e){ fail++; log('에러 ' + full + ' : ' + e); }
  }
  log('완료. 성공 ' + ok + ', 실패 ' + fail);
};
</script>
</body></html>"""


def safe_join(root, rel):
    """root 아래로만 떨어지도록 rel 경로를 정규화. 탈출 시 None."""
    rel = rel.replace("\\", "/")
    # 드라이브 문자/절대경로 제거
    rel = rel.lstrip("/")
    if len(rel) >= 2 and rel[1] == ":":
        rel = rel[2:].lstrip("/")
    parts = []
    for seg in rel.split("/"):
        seg = seg.strip()
        if seg in ("", "."):
            continue
        if seg == "..":
            return None
        # 위험 문자 정리
        if seg in (":", ) or "\x00" in seg:
            return None
        parts.append(seg)
    if not parts:
        return None
    dest = os.path.abspath(os.path.join(root, *parts))
    if os.path.commonpath([dest, root]) != root:
        return None
    return dest


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            page = PAGE.replace("%ROOT%", html.escape(CODING_ROOT))
            self._send(200, page, "text/html; charset=utf-8")
        else:
            self._send(404, "not found")

    def do_POST(self):
        if self.path != "/upload":
            self._send(404, "not found")
            return
        rel = self.headers.get("X-Rel-Path")
        if not rel:
            self._send(400, "X-Rel-Path 헤더 없음")
            return
        rel = unquote(rel)
        dest = safe_join(CODING_ROOT, rel)
        if dest is None:
            self._send(400, "잘못된 경로: " + rel)
            return
        length = int(self.headers.get("Content-Length", "0"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        remaining = length
        try:
            with open(dest, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
        except Exception as e:
            self._send(500, "쓰기 실패: " + str(e))
            return
        self._send(200, "saved: " + os.path.relpath(dest, CODING_ROOT))

    def log_message(self, fmt, *args):
        sys.stderr.write("[upload] " + (fmt % args) + "\n")


if __name__ == "__main__":
    os.makedirs(CODING_ROOT, exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("업로드 서버 시작: http://0.0.0.0:%d  (저장 루트: %s)" % (PORT, CODING_ROOT))
    srv.serve_forever()
