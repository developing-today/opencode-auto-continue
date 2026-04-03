# opencode-auto-continue

OpenCode plugin that automatically sends "continue" when transient errors occur, allowing sessions to recover and resume without manual intervention. Handles API errors, provider issues, context overflow, connection resets, tool failures, and more — with configurable error patterns so you control exactly which errors trigger a retry.

<img width="322" height="162" alt="image" src="https://github.com/user-attachments/assets/51726631-5c5c-474a-8fa1-dd69631140c5" />

## How It Works

1. **Detects errors**: Listens for `session.error` and `message.updated` events
2. **Pattern matching**: Matches error name + message against configurable patterns (case-insensitive substrings). Exclude patterns are checked first to prevent retrying user-initiated aborts.
3. **Waits for idle**: When the session becomes idle after a matched error, sends "continue" via `promptAsync`
4. **Safety limits**: Configurable throttle and max consecutive retries prevent infinite loops
5. **Auto-reset**: Consecutive retry counter resets when a message completes successfully

## Installation

Add to the `plugin` array in your `opencode.jsonc`:

```
"opencode-auto-continue@https://github.com/developing-today/opencode-auto-continue/archive/refs/tags/latest.tar.gz",
```

```jsonc
{
  "plugin": [
    "opencode-auto-continue@https://github.com/developing-today/opencode-auto-continue/archive/refs/tags/latest.tar.gz",
    // ... other plugins
  ]
}
```

Restart OpenCode. The plugin is automatically installed and loaded.

## Commands

The plugin registers `/auto-continue` (and `/ac` as a shorthand alias) for managing settings at runtime.

### Quick Reference

| Command | Description |
|---------|-------------|
| `/auto-continue` | Show help menu with current status and version check |
| `/auto-continue on\|off` | Enable/disable for current session |
| `/auto-continue throttle <ms>` | Set retry throttle (session) |
| `/auto-continue delay <ms>` | Set delay before sending continue (session) |
| `/auto-continue max <n>` | Set max consecutive retries (session) |
| `/auto-continue update-throttle <ms>` | Set update throttle (session) |
| `/auto-continue status` | Show full status, config details, and version check |
| `/auto-continue patterns` | Show all active error match/exclude patterns |
| `/auto-continue reload` | Reload global config from disk |
| `/auto-continue reset` | Clear session overrides, revert to global |
| `/auto-continue global on\|off` | Enable/disable globally (writes config) |
| `/auto-continue global throttle <ms>` | Set global retry throttle (writes config) |
| `/auto-continue global delay <ms>` | Set global delay (writes config) |
| `/auto-continue global max <n>` | Set global max retries (writes config) |
| `/auto-continue global update-throttle <ms>` | Set global update throttle (writes config) |
| `/auto-continue global update` | Clear cache to fetch latest version |

All commands also work with `/ac` (e.g., `/ac status`, `/ac on`, `/ac global update`).

### Session vs Global

- **Session commands** (`on`, `off`, `throttle`, `delay`, `max`, `update-throttle`) change settings for the current session only. They override global settings and are lost when the session ends.
- **Global commands** (`global on`, `global off`, `global throttle`, `global update-throttle`, etc.) write to the config file on disk, affecting all future sessions.
- **`reload`** re-reads the config file from disk into the running plugin (useful if you edited the file manually).
- **`global update`** clears the cached module so the latest version is re-fetched from the `latest` tag on next restart.
- **`reset`** clears session overrides so the session falls back to global config.

## Configuration (Optional)

A config file is **not required**. The plugin works out of the box with sensible defaults. You only need a config file if you want to change the defaults without using the `/auto-continue global` command.

Create `opencode-auto-continue.jsonc` in your `.opencode/` directory. The following shows the current defaults — you only need to include the settings you want to change:

```jsonc
{
  // Retry throttle: minimum ms between auto-continues for the same session
  "throttleMs": 5000,

  // Delay after session becomes idle before sending continue
  "delayMs": 500,

  // Max consecutive auto-continues per session before giving up (0 = unlimited)
  "maxConsecutive": 5,

  // Set to false to disable the plugin without removing it
  "enabled": true,

  // Update throttle: minimum ms between remote version checks.
  // The plugin only checks for new versions when you run /ac, /ac status,
  // or /auto-continue — this controls how often that check hits GitHub.
  "updateThrottleMs": 30000
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `throttleMs` | number | `5000` | Retry throttle: minimum ms between auto-continues per session |
| `delayMs` | number | `500` | Delay after session idle before sending continue |
| `maxConsecutive` | number | `5` | Max consecutive auto-continues before giving up (0 = unlimited) |
| `enabled` | boolean | `true` | Set `false` to disable without removing from plugin list |
| `updateThrottleMs` | number | `30000` | Update throttle: minimum ms between remote version checks |
| `errorPatterns` | string[] | *(see below)* | Error substrings that trigger auto-continue (case-insensitive) |
| `excludePatterns` | string[] | *(see below)* | Error substrings that **never** trigger auto-continue (checked first) |

All fields are optional — omitted keys use the defaults shown above. You can also manage timing settings at runtime via `/auto-continue global <setting> <value>`.

### Error Patterns

The plugin matches each error against a list of patterns. The error is formatted as `"ErrorName: error message"` and each pattern is matched as a case-insensitive substring.

**Exclude patterns are checked first** — if any exclude pattern matches, the error is never retried, even if a match pattern also matches.

Run `/ac patterns` to see the full list of active patterns at any time.

#### Default Match Patterns (19)

These cover the most common transient errors observed across OpenCode sessions:

| Pattern | Catches |
|---------|---------|
| `bad request` | APIError 400 responses |
| `reasoning_opaque` | Multiple reasoning values in single response |
| `prefill` | Assistant message prefill not supported |
| `SSE read timed out` | Server-sent event stream timeouts |
| `DecimalError` | Invalid decimal argument errors |
| `ContextOverflowError` | Session too large to compact |
| `too large to compact` | Context exceeds model limit after stripping |
| `Invalid diff` | Malformed diff in tool output |
| `Tool execution aborted` | Tool execution failures |
| `JSON parsing failed` | JSON parse errors in tool responses |
| `Invalid input for tool` | Bad tool input validation |
| `tried to call unavailable tool` | Tool not available |
| `finding less tool calls` | Tool call count mismatch |
| `tool_use ids were found without tool_result` | Missing tool results |
| `ECONNREFUSED` | Connection refused (mid-stream) |
| `ECONNRESET` | Connection reset (mid-stream) |
| `idle timeout` | Idle timeout on connection |
| `no data received` | Empty response from provider |
| `expected string, received undefined` | Type validation errors |

#### Default Exclude Patterns (2)

| Pattern | Why excluded |
|---------|-------------|
| `MessageAbortedError` | User-initiated abort (Ctrl+C / stop button) |
| `operation was aborted` | Catches abort messages regardless of error name |

#### Custom Patterns

To override the defaults, add `errorPatterns` and/or `excludePatterns` to your config file:

```jsonc
{
  // Replace ALL default match patterns with your own
  "errorPatterns": [
    "bad request",
    "reasoning_opaque",
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

## Logs

The plugin logs all activity with the `[opencode-auto-continue]` prefix:

```
[opencode-auto-continue] No config file at /home/user/.opencode/opencode-auto-continue.jsonc, using defaults
[opencode-auto-continue] Retryable error in abc123: Multiple reasoning_opaque values received...
[opencode-auto-continue] abc123 idle with pending continue, waiting 500ms...
[opencode-auto-continue] Sending "continue" to abc123 (attempt 1/5)
[opencode-auto-continue] Successfully sent "continue" to abc123
```

## Building from Source

```bash
git clone https://github.com/developing-today/opencode-auto-continue.git
cd opencode-auto-continue
bun install
bun run build
```

## License

MIT
