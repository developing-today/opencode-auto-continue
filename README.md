# opencode-auto-continue

OpenCode plugin that automatically sends "continue" when bad request (HTTP 400) errors occur, allowing sessions to recover and resume without manual intervention. These errors are often transient — caused by provider rate limits, temporary API issues, or context window edge cases — and a simple retry usually succeeds.

## How It Works

1. **Detects errors**: Listens for `session.error` and `message.updated` events
2. **Identifies bad requests**: Checks for `ApiError` with status code 400 or messages containing "bad request"
3. **Waits for idle**: When the session becomes idle after an error, sends "continue" via `promptAsync`
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
  "delayMs": 2000,

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

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `throttleMs` | number | `5000` | Retry throttle: minimum ms between auto-continues per session |
| `delayMs` | number | `2000` | Delay after session idle before sending continue |
| `maxConsecutive` | number | `5` | Max consecutive auto-continues before giving up (0 = unlimited) |
| `enabled` | boolean | `true` | Set `false` to disable without removing from plugin list |
| `updateThrottleMs` | number | `30000` | Update throttle: minimum ms between remote version checks. Version is only checked when you run `/ac`, `/ac status`, or `/auto-continue` — this limits how often that check hits GitHub. |

All fields are optional — omitted keys use the defaults shown above. You can also manage these settings at runtime via `/auto-continue global <setting> <value>`.

## Logs

The plugin logs all activity with the `[opencode-auto-continue]` prefix:

```
[opencode-auto-continue] No config file at /home/user/.opencode/opencode-auto-continue.jsonc, using defaults
[opencode-auto-continue] Bad request error in session abc123: Bad Request
[opencode-auto-continue] abc123 idle with pending continue, waiting 2000ms...
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
