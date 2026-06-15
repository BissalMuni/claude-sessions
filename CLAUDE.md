# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote multi-session Claude controller. The PC runs a pool of **Claude Agent SDK sessions** (one per project folder) and serves a web UI so a phone (or any LAN browser) can **monitor each session, approve/deny tool calls (Yes/No), and inject new prompts**. There is no screenshotting or UI automation — everything rides on first-class SDK features: streaming input, the `canUseTool` callback, and input injection.

Read `DESIGN.md` for the full design rationale; `README.md` for the user-facing summary.

## Commands

```powershell
pnpm install
pnpm start                 # tsx src/server.ts  (production-ish run)
pnpm dev                   # tsx watch src/server.ts  (auto-restart on change)
pnpm build                 # tsc -p tsconfig.json → dist/
pnpm test                  # vitest run
pnpm probe                 # tsx scripts/probe-sdk.ts  (SDK behavior probe)
```

Run the server with a fixed access token (PowerShell):

```powershell
$env:SCREEN_TOKEN = "yourtoken"; pnpm start
```

On boot the server prints the LAN URLs (`http://<PC-IP>:8787`) and the token. Open that URL on a phone on the **same WiFi** and enter the token.

**Tests:** vitest is configured but no test files exist yet. New tests should be `*.test.ts` (no `vitest.config` — defaults apply). Run a single file with `pnpm vitest run src/foo.test.ts` or a single case with `pnpm vitest run -t "name"`.

### Environment variables

- `SCREEN_TOKEN` — access token; random hex if unset (printed to console)
- `PORT` (default `8787`), `HOST` (default `0.0.0.0`, exposes on LAN)
- `STALL_HINT_MS` (default `90000`) — silence threshold before a session shows a "stalled?" hint (display only; never kills the session)
- `SCREEN_START_DIR` (default: the parent folder of the server's cwd) — initial folder for the new-session folder picker
- `SDK_DEBUG=1` — enable SDK subprocess debug output; `DEBUG_BLOCKS=1` — dump every SDK message's block types to console

## Architecture

Request/event flow: **phone → REST/WS (`api.ts`/`ws.ts`) → `SessionManager` → `Session` (SDK `query()` loop) → `canUseTool` → back out to phone for approval.**

- **`server.ts`** — entry point. Boots Express + HTTP + WebSocket, mounts three things on one port: `/lite` (server-rendered UI), `/` (static SPA in `web/`), `/api` (REST). Prints LAN IPs.
- **`sessionManager.ts`** — owns the session pool (`Map<id, Session>`), fans `SessionView` changes out to WebSocket subscribers via `subscribe`/`broadcast`, and runs a 10s **stall sweeper** that re-evaluates each session's stalled flag (needed because a silent SDK sends no messages to trigger an update).
- **`session.ts`** — the core. One `Session` = one SDK `query()` call kept alive in **streaming-input mode**. Key behaviors:
  - The `prompt` is an `AsyncQueue` (see `asyncQueue.ts`); pushing a user message into the queue feeds the next turn without restarting the session.
  - `canUseTool` intercepts every tool call: normal tools become a `PendingPermission` routed to the phone for Yes/No; `AskUserQuestion` becomes a `PendingQuestion` (multiple-choice) whose answers are injected back via `updatedInput.answers`. Both block on a Promise from `permissions.ts` until the phone responds (or the session aborts → deny/null).
  - `consume()` reads the SDK output stream and maps messages to status + `StreamItem`s.
  - **Broadcasts are coalesced off the read loop** via `setImmediate` (`scheduleEmit`): a previous version serialized the full view synchronously per message, which could fill the OS pipe buffer and stall the SDK subprocess. Preserve this — don't broadcast synchronously inside the read loop.
- **`permissions.ts`** — `requestId → Promise resolver` registries for both approvals (`Decision`) and questions (`Answers`). `rejectSessionPermissions` cleans up pending waiters when a session ends.
- **`api.ts`** — REST routes (all token-gated). Prompts may carry inline base64 **images** (sent as Anthropic content blocks) and arbitrary **files** (saved by `uploads.ts`, see below). `browse.ts` backs the server-side folder picker.
- **`uploads.ts`** — phone-uploaded files are written to `<cwd>/.uploads/` and their **paths** are appended to the prompt, so Claude reads them with its own tools instead of stuffing base64 into context. Names are sanitized against path traversal.
- **`ws.ts`** — WebSocket hub. Authenticates via `?token=`, sends a full `snapshot` on connect, then streams `session_update`/`session_removed`. Has a 30s ping/pong heartbeat to drop half-open sockets (common with flaky e-ink browsers).
- **`auth.ts`** — single shared `TOKEN`; accepted via `Authorization: Bearer` header or `?token=` query.
- **`types.ts`** — shared domain types (`SessionStatus`, `SessionView`, `StreamItem`, `ServerEvent`, etc.). The server↔client contract lives here.
- **`web/`** — modern SPA (dependency-free vanilla HTML/JS/CSS).
- **`lite.ts`** — alternate UI for old e-ink browsers: **strictly no JavaScript and no flexbox/grid** — pure HTML forms + `<meta refresh>` polling, token threaded through every link's querystring and every form's hidden input. Keep these constraints if you touch it.

### Critical design constraints

- **`settingSources: ['project']`** is set deliberately on every session (`session.ts`). It loads the project's `CLAUDE.md` but does **not** inherit global `~/.claude/settings.json` allow-rules — so *every* tool approval is forced through `canUseTool` (the phone) and can't be silently auto-allowed by a global allowlist. Don't change this to inherit global settings.
- **Default-deny:** if the phone says No or the session aborts, the tool is denied. Safe read-only tools the SDK auto-classifies never reach the phone.
- **Security model is LAN-only + bearer token.** This server can execute tools on the PC, so it's meant only for trusted networks. There is no built-in external-exposure auth.
- Session state is **in-memory only** (capped at `MAX_MESSAGES = 300` per session). No persistence across server restarts; reconnection relies on SDK `resume` semantics, not a saved store.

## Conventions

- ESM throughout (`"type": "module"`); **import local files with the `.js` extension** even though sources are `.ts` (NodeNext resolution) — e.g. `import { Session } from './session.js'`.
- TypeScript `strict` is on.
- Code comments are written in Korean (matching the existing codebase); commit messages in English.
- pnpm is the package manager; vitest is the test runner.
