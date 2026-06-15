@echo off
REM claude-sessions server launcher (double-click to run)
REM Delayed expansion is OFF, so "!" in the token stays literal.

cd /d "%~dp0"
set "SCREEN_TOKEN=changeme"
REM To change the stall timeout, uncomment below (e.g. 12 min):
REM set "STALL_TIMEOUT_MS=720000"

REM pnpm 11's pre-run check aborts on esbuild's blocked build script,
REM so launch the server directly via tsx (same as "pnpm start").
node "node_modules\tsx\dist\cli.mjs" src\server.ts

REM Keep the window open after the server stops (for reading errors).
echo.
echo [Server stopped. Press any key to close this window.]
pause >nul
