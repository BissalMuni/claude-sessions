# restart-guard.ps1
# 컨트롤러(claude-sessions) 재시작용. WMI(Win32_Process.Create)로 띄워지므로
# 기존 컨트롤러 프로세스 트리 '밖'에서 실행된다 → 컨트롤러를 죽여도 이 스크립트는 살아남는다.
$ErrorActionPreference = 'Continue'
$dir = 'C:\Users\minh0\Downloads\coding\claude-sessions'
$log = Join-Path $dir 'restart-guard.log'
function Log($m) { "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Log '=== guard start ==='
# 현재 응답/도구 정리가 끝나도록 잠깐 대기
Start-Sleep -Seconds 4

# 8787 리스너(현재 컨트롤러) PID를 실행 시점에 다시 찾아서 트리째 종료
$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $old = $c.OwningProcess
  Log "killing controller tree PID=$old"
  & taskkill /F /T /PID $old | Out-Null
} else {
  Log 'no listener on 8787 to kill'
}

# 포트가 풀릴 때까지 최대 ~15초 대기
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  $busy = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if (-not $busy) { break }
}
Log 'port 8787 free, starting new controller'

# 새 컨트롤러를 보이는 창으로 기동(평소 운영 방식과 동일: pnpm start)
Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoExit', '-Command', "cd '$dir'; pnpm start" `
  -WorkingDirectory $dir
Log '=== guard done (new controller launched) ==='
