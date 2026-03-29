# opencode-auto-continue

OpenCode plugin that automatically sends "continue" when bad request (HTTP 400) errors occur, allowing sessions to recover and resume without manual intervention.

## How It Works

1. **Detects errors**: Listens for `session.error` and `message.updated` events
2. **Identifies bad requests**: Checks for `ApiError` with status code 400 or messages containing "bad request"
3. **Waits for idle**: When the session becomes idle after an error, sends "continue" via `promptAsync`
4. **Safety limits**: Configurable cooldown and max consecutive retries prevent infinite loops
5. **Auto-reset**: Consecutive retry counter resets when a message completes successfully

## Installation

Add to the `plugin` array in your `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "github:developing-today/opencode-auto-continue",
    // ... other plugins
  ]
}
```

Restart OpenCode. The plugin is automatically installed and loaded.

## Commands

The plugin registers the `/auto-continue` command for managing settings at runtime.

### Quick Reference

| Command | Description |
|---------|-------------|
| `/auto-continue` | Show help menu with current status |
| `/auto-continue on\|off` | Enable/disable for current session |
| `/auto-continue cooldown <ms>` | Set cooldown between retries (session) |
| `/auto-continue delay <ms>` | Set delay before sending continue (session) |
| `/auto-continue max <n>` | Set max consecutive retries (session) |
| `/auto-continue status` | Show full status and config details |
| `/auto-continue reset` | Clear session overrides, revert to global |
| `/auto-continue global on\|off` | Enable/disable globally (writes config) |
| `/auto-continue global cooldown <ms>` | Set global cooldown (writes config) |
| `/auto-continue global delay <ms>` | Set global delay (writes config) |
| `/auto-continue global max <n>` | Set global max retries (writes config) |

### Session vs Global

- **Session commands** (`on`, `off`, `cooldown`, `delay`, `max`) change settings for the current session only. They override global settings and are lost when the session ends.
- **Global commands** (`global on`, `global off`, `global cooldown`, etc.) write to the config file on disk, affecting all future sessions.
- `/auto-continue reset` clears session overrides so the session falls back to global config.

## Configuration (Optional)

A config file is **not required**. The plugin works out of the box with sensible defaults. You only need a config file if you want to change the default settings globally without using the `/auto-continue global` command.

Create `opencode-auto-continue.jsonc` in your `.opencode/` directory:

```jsonc
{
  // Minimum ms between auto-continues for the same session
  "cooldownMs": 5000,

  // Delay after session becomes idle before sending continue
  "delayMs": 2000,

  // Max consecutive auto-continues per session before giving up
  "maxConsecutive": 5,

  // Set to false to disable the plugin without removing it
  "enabled": true
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cooldownMs` | number | `5000` | Minimum ms between auto-continues per session |
| `delayMs` | number | `2000` | Delay after session idle before sending continue |
| `maxConsecutive` | number | `5` | Max consecutive auto-continues before giving up |
| `enabled` | boolean | `true` | Set `false` to disable without removing from plugin list |

All fields are optional — missing keys use defaults. You can also manage these settings at runtime via `/auto-continue global <setting> <value>`.

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
