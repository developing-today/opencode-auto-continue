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

## Configuration

Create `opencode-auto-continue.jsonc` in your `.opencode/` directory (or `~/.config/opencode/`). All fields are optional — missing keys use defaults.

```jsonc
{
  // Minimum ms between auto-continues for the same session (prevents rapid-fire)
  "cooldownMs": 5000,

  // Delay after session becomes idle before sending continue (lets things settle)
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

If no config file exists, the plugin runs with all defaults.

## Logs

The plugin logs all activity with the `[opencode-auto-continue]` prefix:

```
[opencode-auto-continue] No config file at /home/user/.opencode/opencode-auto-continue.jsonc, using defaults
[opencode-auto-continue] Bad request error in session abc123: Bad Request
[opencode-auto-continue] Session abc123 is idle with pending continue, waiting 2000ms...
[opencode-auto-continue] Sending "continue" to session abc123 (attempt 1/5)
[opencode-auto-continue] Successfully sent "continue" to session abc123
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
