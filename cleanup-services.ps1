# 불필요 서비스 정리 (관리자 권한 필요) — 결과를 로그 파일에 기록
# 사용자 확인: 게임 안 함 / 와콤 안 씀 / 인터넷뱅킹 거의 안 함
$ErrorActionPreference = 'Continue'
$log = "C:\Users\minh0\Downloads\coding\claude-sessions\cleanup-services.log"
"=== 서비스 정리 시작 ===" | Out-File $log -Encoding utf8

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"관리자 권한: $admin" | Out-File $log -Append -Encoding utf8

$disable = @('DiagTrack','IJPLMSVC','KOS_Service','WTabletServicePro','GameInputRedistService')
$manual  = @('GamingServices','GamingServicesNet','SafeTransactionSVC','RansomDefenderS','SamsungUpdateService')

foreach ($s in $disable) {
  $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
  if ($svc) {
    try { Stop-Service -Name $s -Force -ErrorAction SilentlyContinue } catch {}
    try { Set-Service -Name $s -StartupType Disabled -ErrorAction Stop; "[Disabled] $s" | Out-File $log -Append -Encoding utf8 }
    catch { "[실패-Disabled] $s : $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8 }
  } else { "[없음] $s" | Out-File $log -Append -Encoding utf8 }
}
foreach ($s in $manual) {
  $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
  if ($svc) {
    try { Stop-Service -Name $s -Force -ErrorAction SilentlyContinue } catch {}
    try { Set-Service -Name $s -StartupType Manual -ErrorAction Stop; "[Manual] $s" | Out-File $log -Append -Encoding utf8 }
    catch { "[실패-Manual] $s : $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8 }
  } else { "[없음] $s" | Out-File $log -Append -Encoding utf8 }
}
"=== 완료 ===" | Out-File $log -Append -Encoding utf8
