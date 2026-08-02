# 컨트롤러(포트 8787) 안전 재시작 — SCREEN_PERF=1 로 응답 지연 계측을 켜서 띄운다.
# 이 스크립트는 WMI(Win32_Process.Create)로 실행돼 컨트롤러 프로세스 트리 '밖'에서 돌기 때문에,
# 아래에서 컨트롤러 트리를 통째로 죽여도 이 스크립트 자신은 살아남아 재기동을 끝낸다.
$ErrorActionPreference = 'SilentlyContinue'
$proj = 'C:\Users\minh0\Downloads\coding\claude-sessions'
$log  = Join-Path $proj 'logs\restart.log'
function Log($m) { "[{0}] {1}" -f (Get-Date -Format o), $m | Out-File -FilePath $log -Append -Encoding utf8 }

Log 'restart-with-perf: 시작 — 폰에 마지막 응답 전달 대기(6s)'
Start-Sleep -Seconds 6  # 세션 기록 디바운스 저장(~1s) + 폰 전달 여유

# 현재 리스너와 그 부모(tsx 런처)를 찾아 트리째 종료
$listener = Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object -First 1
if ($listener) {
  $pid8787 = [int]$listener.OwningProcess
  $parent  = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid8787").ParentProcessId
  Log "종료 대상: listener=$pid8787 parent=$parent"
  if ($parent) { taskkill /F /T /PID $parent | Out-Null }   # 런처 트리 = 런처+서버+claude 세션들
  taskkill /F /T /PID $pid8787 | Out-Null                    # 혹시 남은 서버 트리
} else {
  Log '리스너 없음(이미 내려감) — 바로 기동'
}

# 포트 해제 대기(최대 15s)
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen)) { break }
  Start-Sleep -Milliseconds 500
}

# 새 서버 기동 — 계측 ON. .env 의 계정/토큰은 앱이 알아서 로드한다.
$env:SCREEN_PERF = '1'
$outLog = Join-Path $proj 'logs\server-out.log'
$errLog = Join-Path $proj 'logs\server-err.log'
$tsx = Join-Path $proj 'node_modules\tsx\dist\cli.mjs'
Log "새 서버 기동: node $tsx src\server.ts (SCREEN_PERF=1)"
Start-Process -FilePath 'node.exe' -ArgumentList "`"$tsx`"", 'src\server.ts' `
  -WorkingDirectory $proj -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Log 'restart-with-perf: 기동 요청 완료'
