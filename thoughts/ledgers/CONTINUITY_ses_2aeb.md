---
session: ses_2aeb
updated: 2026-04-03T03:03:55.514Z
---



## Summary

### Task
The user asked for an exhaustive exploration of the `opencode-auto-continue` codebase at `/home/user/opencode-auto-continue` to understand the full implementation, configuration structure, error handling, consecutive max tracking, and how it interacts with OpenCode.

### What Was Done
A complete read of every significant file in the repository was performed. Here is the exhaustive analysis:

---

### File Inventory & Purposes

| File                                    | Purpose                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/index.ts` (860 lines)                | **Sole source file** — the entire plugin                                                              |
| `dist/index.js` (738 lines)               | Compiled JS output (matches src, already built)                                                   |
| `dist/index.d.ts` (4 lines)               | Type declaration — just re-exports `Plugin` type                                                    |
| `dist/index.js.map`, `dist/index.d.ts.map`  | Source maps                                                                                       |
| `package.json`                            | Package config, ESM, peer deps on `@opencode-ai/plugin` and `@opencode-ai/sdk`                        |
| `tsconfig.json`                           | TS config: ES2022 target, bundler resolution, strict                                              |
| `justfile`                                | Build tasks: `install`, `build`, `dev`, `clean`, `rebuild`, `check`, `info`                                     |
| `shell.nix`                               | Dev shell with bun, nodejs_22, typescript, just                                                   |
| `README.md` (128 lines)                   | Documentation with install, commands, config reference                                            |
| `.gitignore`                              | Ignores node_modules, bun.lock, *.tgz, session files                                              |
| `.github/workflows/tag-latest.yml`        | CI: on push to main → tags `latest` + dated tag, creates GitHub releases with sha512 content hashes |
| `.opencode/opencode-auto-continue.jsonc`  | **Local config file (STALE — uses old key names)**                                                    |
| `.opencode/package.json`                  | OpenCode's local plugin dependency                                                                |
| `thoughts/ledgers/CONTINUITY_ses_2c60.md` | Previous session's continuity ledger documenting a rename refactor                                |

---

### Config Structure

**Code defaults** (in `DEFAULTS` const, line 40-51 of `src/index.ts`):
```ts
{
  throttleMs: 5_000,      // Min ms between auto-continues per session
  delayMs: 500,           // Delay after session.idle before sending continue
  maxConsecutive: 5,       // Max consecutive auto-continues (0 = unlimited)
  enabled: true,           // Whether plugin is active
  updateThrottleMs: 30_000 // Min ms between remote GitHub version checks
}
```

**Interface** (line 53-59):
```ts
interface Config {
  throttleMs: number;
  delayMs: number;
  maxConsecutive: number;
  enabled: boolean;
  updateThrottleMs: number;
}
```

**Actual `.opencode/opencode-auto-continue.jsonc` on disk** (STALE/MISMATCHED):
```json
{
  "cooldownMs": 5,
  "delayMs": 500,
  "maxConsecutive": 5,
  "enabled": true,
  "checkIntervalMs": 30000
}
```
⚠️ **Critical issue**: The on-disk config uses OLD key names (`cooldownMs`, `checkIntervalMs`) that the code no longer reads. The `loadConfig` function (line 110-134) only looks for `throttleMs`, `delayMs`, `maxConsecutive`, `enabled`, `updateThrottleMs`. So the `cooldownMs: 5` and `checkIntervalMs: 30000` are **silently ignored** — the plugin falls back to defaults for those fields.

**README default example** shows `delayMs: 2000` but code default is `delayMs: 500` — a documentation mismatch.

---

### How Auto-Continue Works (Complete Flow)

1. **Plugin initialization** (line 167): `async ({ client, directory }) => { ... }` — receives OpenCode client and working directory. Creates two Maps: `sessions` (per-session state) and `sessionConfigs` (per-session config overrides). Loads global config from `.opencode/opencode-auto-continue.jsonc`. Snapshots the bun.lock content hash at load time.

2. **Hooks returned** (line 766-857):
   - `config`: Registers `/auto-continue` and `/ac` commands with OpenCode
   - `command.execute.before`: Routes those commands to `handleCommand()`
   - `event`: The core auto-continue logic — listens to 3 event types

3. **Error Detection** (lines 787-839): Listens for two event types:
   - **`session.error`** (line 789): Extracts `sessionID` and `error` from `event.properties`. If `isBadRequestError(error)` → sets `pendingContinue = true` on that session's state
   - **`message.updated`** (line 809): Only processes assistant-role messages. Two sub-behaviors:
     - If `isBadRequestError(info.error)` → sets `pendingContinue = true`
     - If `info.metadata?.done && !info.error` → **resets `consecutiveCount` to 0** (successful completion)

4. **`isBadRequestError` function** (line 136-152): Catches errors where:
   - `err.name === "APIError"` or `"ApiError"` AND (`data.statusCode === 400` OR `data.message` contains "bad request")
   - `err.name === "UnknownError"` AND `data.message` contains "bad request"
   - **Only catches HTTP 400 bad request errors — NOT rate limits (429), server errors (500), timeouts, etc.**

5. **Continue Trigger** (lines 842-855): On `session.idle` event → if `state.pendingContinue` is true → calls `setTimeout(() => sendContinue(sessionID), config.delayMs)`

6. **`sendContinue` function** (lines 323-360): The actual retry logic:
   - Bails if `pendingContinue` is no longer true
   - **Throttle check**: If `now - lastContinueTime < throttleMs` → silently skips
   - **Max consecutive check**: If `maxConsecutive > 0 && consecutiveCount >= maxConsecutive` → gives up, clears `pendingContinue`
   - Otherwise: increments `consecutiveCount`, clears `pendingContinue`, sends `"continue"` via `client.session.promptAsync()`

---

### `maxConsecutive` — Truly Consecutive, With Auto-Reset

The counter is **truly consecutive** — it's tracked in `SessionState.consecutiveCount` (line 66). Key behaviors:

- **Incremented**: Each time `sendContinue` actually fires (line 343: `state.consecutiveCount++`)
- **Reset to 0**: When `message.updated` fires with `info.metadata?.done && !info.error` (line 834-836) — i.e., when an assistant message completes successfully
- **Checked before sending**: `consecutiveCount >= maxConsecutive` (line 336) — so with default of 5, it allows attempts 1-5 then stops
- **Per-session**: Each session has its own `SessionState` in the `sessions` Map
- **0 = unlimited**: When `maxConsecutive === 0`, the check is skipped entirely (line 336: `config.maxConsecutive > 0 && ...`)

So the flow is: error → error → error → error → error (5 retries) → gives up. But if any retry succeeds (assistant completes), the counter resets to 0 and it can retry again on the next error.

---

### Session State Structure (line 61-66)
```ts
interface SessionState {
  lastErrorTime: number;       // Timestamp of last bad request error
  lastContinueTime: number;    // Timestamp of last sent continue (for throttle)
  pendingContinue: boolean;    // Whether a continue should fire on next idle
  consecutiveCount: number;    // Current consecutive retry count
}
```

---

### Config Layering System

Three layers, merged with spread:
1. **DEFAULTS** (hardcoded const)
2. **Global config** (loaded from `.opencode/opencode-auto-continue.jsonc` at startup, mutated by `/ac global` commands)
3. **Session overrides** (`sessionConfigs` Map, set by `/ac throttle`, `/ac on`, etc.)

Merge logic (line 283-288): `{ ...globalConfig, ...sessionOverrides }` — session wins.

---

### Command System

Commands registered via `config` hook. Both `/auto-continue` and `/ac` route to same `handleCommand()`. All commands use `throw new Error("__AUTO_CONTINUE_HANDLED__")` pattern to signal to OpenCode that the command was handled (prevents further processing).

Commands: `help` (default), `on`/`off`, `throttle <ms>`, `delay <ms>`, `max <n>`, `update-throttle <ms>`, `status`, `reload`, `reset`, `global on|off|throttle|delay|max|update-throttle|update`

---

### Version/Update System

- At load: reads sha512 content hash from `~/.cache/opencode/bun.lock`
- `versionInfo()`: Compares loaded hash vs current bun.lock hash vs remote (GitHub release body first line)
- `fetchLatestHash()`: Fetches from `https://api.github.com/repos/developing-today/opencode-auto-continue/releases/tags/latest`, debounced by `updateThrottleMs`
- `/ac global update`: Clears `~/.cache/opencode/node_modules/opencode-auto-continue`, removes from cache package.json dependencies, removes bun.lock, clears bun's install cache entries

---

### Logging

The `log()` function (line 172-174) is **intentionally silent** — it's a no-op. Comment says "console.log leaks into the TUI as raw terminal output." All log calls exist but produce no output.

---

### Known Issues Identified

1. **Stale config file**: `.opencode/opencode-auto-continue.jsonc` uses old key names (`cooldownMs`, `checkIntervalMs`) from before the rename refactor documented in `CONTINUITY_ses_2c60.md`. These are silently ignored, so the plugin uses defaults instead of the intended `cooldownMs: 5`.

2. **README `delayMs` mismatch**: README example shows `delayMs: 2000` but code default is `delayMs: 500`.

3. **Previous session rename was completed**: The `CONTINUITY_ses_2c60.md` ledger said the rename was partially done, but the current `src/index.ts` and `dist/index.js` show the rename is fully complete — all code uses `throttleMs`/`updateThrottleMs`. The on-disk config file just wasn't updated to match.

4. **User previously reported**: On Mac, `/ac status` shows whitespace then "Set max retries (session)" instead of the tarball version info. The `helpText()` function (line 400-426) includes the line `"  /auto-continue max <n>             Set max retries (session, 0=unlimited)"` — if the version info returns empty/whitespace, the next visible line in the help text would be about max retries. This could be a rendering issue where the status box renders but version info is blank on Mac.

### No Work Was Started
This was purely an exploration/analysis request. No files were modified.
