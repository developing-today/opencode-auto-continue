# opencode-auto-continue

OpenCode **v2** plugin that automatically sends "continue" when transient errors or completed empty assistant responses occur, allowing sessions to recover and resume without manual intervention. Handles API errors, provider issues, context overflow, connection resets, tool failures, empty provider responses, and more — with configurable safeguards so you control exactly which failures trigger a retry.

> **OpenCode v2 required.** This plugin uses the v2 plugin API (`Plugin.define` + `ctx.*` domains) and will not load under OpenCode v1. It is verified against a real OpenCode **2.0.28** host and developed against `@opencode/plugin` 2.0.32. V1 users should stay on the previous 1.x release of this plugin.

<img width="322" height="162" alt="image" src="https://github.com/user-attachments/assets/51726631-5c5c-474a-8fa1-dd69631140c5" />

## How It Works

1. **Detects recoverable failures**: Subscribes to the v2 event stream and watches `session.execution.failed` / `session.step.failed` errors plus completed steps that end with `finish: "unknown"` and zero output tokens (partial text is deliberately still treated as a broken response — see [Completed Empty Responses](#completed-empty-responses)).
2. **Pattern and state matching**: Matches structured errors against configurable patterns and strictly validates the latest assistant step before treating an empty response as recoverable. User interruptions, tool calls, questions, and permission prompts are excluded.
3. **Cooperates with OpenCode's built-in retries**: When OpenCode schedules its own provider retry (`session.retry.scheduled`, status `retry`), the plugin stands down and does not double-retry. It acts when retries are exhausted and the turn fails, or when the failure is terminal.
4. **Waits for idle**: When the session becomes idle after a recoverable failure, rechecks the latest state after the configured delay and sends "continue" via `ctx.session.prompt` (keeping the session's selected agent and model).
5. **Recovers stalled requests**: Interrupts a request that remains busy for 200 seconds without any real assistant activity (`ctx.session.interrupt`), then sends "continue" after the session becomes idle.
6. **Safety limits**: Configurable throttle and max consecutive retries prevent infinite loops.
7. **Auto-reset**: Consecutive retry counter resets when a step completes with `finish: "stop"`.

Each plugin instance only acts on events attributed to its own location — events that carry a foreign project directory (or a foreign workspace, when the plugin itself is workspace-scoped) are ignored.

## Installation

Add the package to the `plugins` array in your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-auto-continue@https://github.com/developing-today/opencode-auto-continue/archive/refs/tags/latest.tar.gz",
    // ... other plugins
  ]
}
```

Restart OpenCode. The plugin is automatically installed (via Bun into OpenCode's cache) and loaded.

You can also install from a local checkout — configure the **directory** that contains the `package.json`, never a path to `dist/index.js` (OpenCode rejects file paths with `configured plugin path must be a directory`):

```jsonc
{
  "plugins": [
    "../opencode-auto-continue"
  ]
}
```

### Updating

Plugin versions are managed entirely by OpenCode v2 through the `plugins` array — change the package spec (for example pin a tag or version) and restart. The 1.x-era `/ac global update` cache-wipe command was removed because it deleted OpenCode's global cache/config/data directories; updating that way is no longer needed or supported.

## Commands

The plugin registers `/auto-continue` (and `/ac` as a shorthand alias) for managing settings at runtime. Command output is rendered as synthetic chat messages and never triggers a model call.

### Quick Reference

| Command | Description |
|---------|-------------|
| `/auto-continue` | Show help menu with current status |
| `/auto-continue on\|off` | Enable/disable for current session |
| `/auto-continue throttle <ms>` | Set retry throttle (session) |
| `/auto-continue delay <ms>` | Set delay before sending continue (session) |
| `/auto-continue max <n>` | Set max consecutive retries (session) |
| `/auto-continue status` | Show full status and config details |
| `/auto-continue patterns` | Show all active error match/exclude patterns |
| `/auto-continue reload` | Reload global config from disk |
| `/auto-continue reset` | Clear session overrides, revert to global |
| `/auto-continue global on\|off` | Enable/disable globally (writes config) |
| `/auto-continue global throttle <ms>` | Set global retry throttle (writes config) |
| `/auto-continue global delay <ms>` | Set global delay (writes config) |
| `/auto-continue global max <n>` | Set global max retries (writes config) |

All commands also work with `/ac` (e.g., `/ac status`, `/ac on`, `/ac global off`).

### Session vs Global

- **Session commands** (`on`, `off`, `throttle`, `delay`, `max`) change settings for the current session only. They override global settings and are lost when the session ends. Disabling a session (`off`) immediately cancels any queued retry for it.
- **Global commands** (`global on`, `global off`, `global throttle`, `global delay`, `global max`) write to the config file on disk, affecting all future sessions. `global off` cancels queued retries in every session.
- **`reload`** re-reads the config file from disk into the running plugin (useful if you edited the file manually).
- **`reset`** clears session overrides so the session falls back to global config.

## Configuration (Optional)

A config file is **not required**. The plugin works out of the box with sensible defaults. You only need a config file if you want to change the defaults without using the `/auto-continue global` command.

Create `opencode-auto-continue.jsonc` in your `.opencode/` directory. The following shows the current defaults — you only need to include the settings you want to change:

```jsonc
{
  // Retry throttle: minimum ms between auto-continues for the same session
  "throttleMs": 5000,

  // Delay after the session becomes idle before sending continue
  "delayMs": 500,

  // Max consecutive auto-continues per session before giving up (0 = unlimited)
  "maxConsecutive": 5,

  // Set to false to disable the plugin without removing it
  "enabled": true,

  // Retry finish="unknown" assistant responses with zero output tokens
  // and no error (partial text does not block the retry)
  "retryEmptyResponses": true,

  // Interrupt and retry after 200 seconds with no text, reasoning, tool call,
  // or output token. Set to 0 to disable stalled-request recovery
  "stalledRequestTimeoutMs": 200000
}
```

> **Migrating from the 1.x config?** The file name and location are unchanged, and all settings above keep their meaning. The 1.x-only keys `updateThrottleMs` and `offlineMode` no longer exist (the remote version check was removed along with self-update); they are ignored if still present, and it is safe to delete them.

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `throttleMs` | number | `5000` | Retry throttle: minimum ms between auto-continues per session |
| `delayMs` | number | `500` | Delay after session idle before sending continue |
| `maxConsecutive` | number | `5` | Max consecutive auto-continues before giving up (0 = unlimited) |
| `enabled` | boolean | `true` | Set `false` to disable without removing from plugin list |
| `retryEmptyResponses` | boolean | `true` | Retry completed zero-output assistant responses (`finish: "unknown"`, no error) without an explicit failure |
| `stalledRequestTimeoutMs` | number | `200000` | Interrupt and retry a busy request with no real assistant activity after this delay (0 disables) |
| `errorPatterns` | string[] | *(see below)* | Error substrings that trigger auto-continue (case-insensitive) |
| `excludePatterns` | string[] | *(see below)* | Error substrings that **never** trigger auto-continue (checked first) |

All fields are optional — omitted keys use the defaults shown above. You can also manage timing settings at runtime via `/auto-continue global <setting> <value>`.

### Completed Empty Responses

Some providers can finish a request without emitting an explicit error or a usable assistant response. The plugin treats this as recoverable only when the latest assistant step has all of the following properties when the session becomes idle:

- `finish` is exactly `"unknown"`
- output token count is `0`
- no error was reported for the step
- the turn was not interrupted by the user
- the session is not waiting for a question answer or permission reply

Partial text is deliberately **not** excluded: an `unknown` finish with zero billed output tokens indicates a broken stream even when some text was emitted, so those responses are retried as well (this matches the 1.x behavior).

The existing `delayMs`, `throttleMs`, and `maxConsecutive` limits apply. A late successful `finish: "stop"` step cancels a queued retry, and a successful stop resets the consecutive retry counter. Set `retryEmptyResponses` to `false` to retain error-only behavior.

### Stalled Requests

The plugin starts a watchdog when a session becomes busy. If the request remains busy for `stalledRequestTimeoutMs` without emitting non-empty text, reasoning, a tool call, or any output token, the plugin interrupts the session (`ctx.session.interrupt` with `resume: false`) and sends "continue" after the session becomes idle.

The default timeout is 200 seconds. Once real assistant activity begins, the watchdog is cancelled, so it does not impose a total-duration limit on long responses or tool executions. User-initiated interruptions, questions, and permission prompts remain excluded from automatic recovery. Set `stalledRequestTimeoutMs` to `0` to disable this behavior.

### Error Patterns

The plugin matches each error against a list of patterns. OpenCode v2 reports structured errors like `{ type: "provider.transport", message: "SSE read timed out" }`; the plugin formats each error as `"ErrorType: error message"` and matches every pattern as a case-insensitive substring — so both the structured type and the provider's raw message text are matchable.

**Exclude patterns are checked first** — if any exclude pattern matches, the error is never retried, even if a match pattern also matches.

Run `/ac patterns` to see the full list of active patterns at any time.

#### Default Match Patterns (26)

Structured v2 error types:

| Pattern | Catches |
|---------|---------|
| `provider.invalid-request` | HTTP 400s and classified invalid requests (includes context-overflow classifications) |
| `provider.invalid-output` | Incomplete or invalid provider output streams |
| `provider.transport` | Connection resets, refused connections, SSE failures |
| `provider.timeout` | Request timeouts |
| `provider.internal` | Provider-side (5xx) failures |
| `provider.unknown` | Unrecognized transient provider failures |
| `tool.execution` | Tool failures that terminate a step |

Message-text patterns carried over from 1.x (they still match against the raw provider/tool message):

`bad request`, `reasoning_opaque`, `prefill`, `SSE read timed out`, `DecimalError`, `ContextOverflowError`, `too large to compact`, `Invalid diff`, `Tool execution aborted`, `JSON parsing failed`, `Invalid input for tool`, `tried to call unavailable tool`, `finding less tool calls`, `tool_use ids were found without tool_result`, `ECONNREFUSED`, `ECONNRESET`, `idle timeout`, `no data received`, `expected string, received undefined`.

Note that OpenCode v2 feeds most ordinary tool failures back to the model as tool results instead of failing the turn; the tool patterns above only matter for tool errors that actually terminate a step.

#### Default Exclude Patterns (2)

| Pattern | Why excluded |
|---------|-------------|
| `MessageAbortedError` | Legacy abort error name |
| `operation was aborted` | Catches abort messages regardless of error type |

User interruptions in v2 usually surface as `session.execution.interrupted` events rather than errors; the plugin never auto-continues those regardless of patterns.

#### Custom Patterns

To override the defaults, add `errorPatterns` and/or `excludePatterns` to your config file:

```jsonc
{
  // Replace ALL default match patterns with your own
  "errorPatterns": [
    "provider.invalid-request",
    "provider.transport",
    "my custom error"
  ],

  // Replace ALL default exclude patterns with your own
  "excludePatterns": [
    "MessageAbortedError",
    "operation was aborted"
  ]
}
```

**Note:** Setting `errorPatterns` or `excludePatterns` in the config replaces the entire default list, not appends to it. Include any defaults you want to keep. When these fields are omitted, the built-in defaults are used and are **not** written to the config file.

## What changed in the v2 migration

- **Plugin API**: the plugin now default-exports `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin` instead of a v1 hook object. `setup` returns a cleanup function that cancels timers and the event subscription when the plugin unloads.
- **Events**: v1 `session.error` / `message.updated` / `message.part.updated` do not exist in v2. The plugin now follows `session.execution.*`, `session.step.*`, `session.text.*`, `session.tool.*`, `session.status`, `session.idle`, `permission.*`, `form.*` (the v2 question mechanism), and `session.deleted` (per-session state is now cleaned up on deletion).
- **Built-in retries**: v2 retries provider failures itself. The plugin waits for those retries to finish before acting, and stands down while a retry is scheduled.
- **Commands**: `/auto-continue` and `/ac` are registered through `ctx.command.transform`; the v1 `command.execute.before` short-circuit hack is gone. Command output uses `ctx.session.synthetic` with `resume: false` — display-only, no model call.
- **Self-update removed**: the 1.x remote version check and `/ac global update [force]` cache-wipe machinery were removed. Updates are handled by OpenCode v2's plugin package management.
- **Location scoping**: events that carry a location different from the plugin's own are ignored.

## Logs

The plugin is intentionally silent: it does not write to the TUI outside of the `/ac` command output. Use `/ac status` to inspect current settings and per-session retry state.

## Building from Source

```bash
git clone https://github.com/developing-today/opencode-auto-continue.git
cd opencode-auto-continue
bun install
bun run build   # emits dist/
bun test        # unit tests (no model calls)
```

The published package loads `dist/index.js` through the `exports` field; `@opencode/plugin` is a regular dependency (`^2.0.28`).

## License

MIT
