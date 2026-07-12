@echo off
REM ── 8787 인바운드 허용 방화벽 규칙 추가 (관리자 권한 필요) ──
REM 이 파일을 우클릭 → "관리자 권한으로 실행"

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] 관리자 권한이 아닙니다. 이 파일을 우클릭 - "관리자 권한으로 실행" 하세요.
    pause
    exit /b 1
)

echo 기존 규칙 제거...
netsh advfirewall firewall delete rule name="claude-sessions 8787" >nul 2>&1
netsh advfirewall firewall delete rule name="dev 5173" >nul 2>&1

echo 규칙 추가 (TCP 8787 / 5173, 모든 프로필 인바운드 허용)...
netsh advfirewall firewall add rule name="claude-sessions 8787" dir=in action=allow protocol=TCP localport=8787 profile=any
netsh advfirewall firewall add rule name="dev 5173" dir=in action=allow protocol=TCP localport=5173 profile=any

echo.
echo 완료. 이제 다른 기기에서 아래 주소로 접속해 보세요.
echo   http://192.168.0.5:8787
echo   http://192.168.0.5:5173
pause
