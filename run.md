# 서버 실행

## PowerShell

```powershell
cd C:\Users\minh0\Downloads\coding\claude-sessions
$env:SCREEN_TOKEN = "!"; pnpm start
```

한 줄로:

```powershell
cd C:\Users\minh0\Downloads\coding\claude-sessions; $env:SCREEN_TOKEN="!"; pnpm start
```

## CMD (명령 프롬프트)

```cmd
cd /d C:\Users\minh0\Downloads\coding\claude-sessions
set "SCREEN_TOKEN=!" && pnpm start
```

한 줄로:

```cmd
cd /d C:\Users\minh0\Downloads\coding\claude-sessions && set "SCREEN_TOKEN=changeme" && pnpm start
```

- `SCREEN_TOKEN` = 폰/기기 접속 비밀번호. 안 정하면 서버가 랜덤 생성해 콘솔에 출력.
- 타임아웃도 바꾸려면 (예: 12분):
  - PowerShell: `$env:STALL_TIMEOUT_MS="720000"`
  - CMD: `set "STALL_TIMEOUT_MS=720000"`
