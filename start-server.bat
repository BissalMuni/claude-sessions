@echo off
REM claude-sessions server launcher (double-click to run)
REM Delayed expansion is OFF, so "!" in the token stays literal.

cd /d "%~dp0"
set "SCREEN_TOKEN=changeme"
REM To change the stall timeout, uncomment below (e.g. 12 min):
REM set "STALL_TIMEOUT_MS=720000"

REM pnpm 11's pre-run check aborts on esbuild's blocked build script,
REM so launch the server directly via tsx (same as "pnpm start").
REM
REM Auto-restart loop: an agent session (danger mode) can run "taskkill /IM node.exe"
REM to clean up its own dev server, which also kills THIS controller (also node.exe).
REM This cmd.exe window is NOT node, so it survives and relaunches the server.
REM To quit for real: press Ctrl+C and answer Y, or just close this window.
:loop
node "node_modules\tsx\dist\cli.mjs" src\server.ts
echo.
echo [Server stopped at %date% %time% - restarting in 3s... Ctrl+C to quit]
timeout /t 3 /nobreak >nul
goto loop
