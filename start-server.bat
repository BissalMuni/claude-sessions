@echo off
REM claude-sessions 서버 시작 배치 (시작프로그램용)
REM 지연 확장(delayed expansion)을 켜지 않으므로 "!" 토큰이 그대로 들어감

cd /d "D:\Coding\claude-sessions"
set "SCREEN_TOKEN=changeme"
REM 타임아웃을 바꾸려면 아래 주석을 해제 (예: 12분)
REM set "STALL_TIMEOUT_MS=720000"

pnpm start

REM 서버가 종료되어도 창이 닫히지 않도록 (오류 확인용)
echo.
echo [서버가 종료되었습니다. 아무 키나 누르면 창이 닫힙니다.]
pause >nul
