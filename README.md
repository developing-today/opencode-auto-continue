# opencode-auto-continue

OpenCode plugin that automatically sends "continue" when bad request (HTTP 400) errors occur, allowing sessions to recover and resume without manual intervention.

## How It Works

1. **Detects errors**: Listens for `session.error` and `message.updated` events
2. **Identifies bad requests**: Checks for `ApiError` with status code 400 or messages containing "bad request"
3. **Waits for idle**: When the session becomes idle after an error, sends "continue" via `promptAsync`
4. **Safety limits**: Cooldown (5s) and max consecutive retries (5) prevent infinite loops

## Installation

### 1. Add the dependency

Add to your `~/.config/opencode/package.json` (or `.opencode/package.json` in your project):

```json
{
  "dependencies": {
    "opencode-auto-continue": "github:developing-today/opencode-auto-continue"
  }
}
```

Then install:

```bash
cd ~/.config/opencode  # or your .opencode/ directory
bun install
```

### 2. Enable the plugin

Add `"opencode-auto-continue"` to the `plugin` array in your `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "opencode-auto-continue",
    // ... other plugins
  ]
}
```

### 3. Restart OpenCode

The plugin loads on startup. Restart OpenCode to activate it.

## Building from Source

```bash
git clone https://github.com/developing-today/opencode-auto-continue.git
cd opencode-auto-continue
bun install
bun run build
```

## Configuration

Currently uses hardcoded defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| `COOLDOWN_MS` | 5000 | Minimum ms between auto-continues per session |
| `DELAY_MS` | 2000 | Delay after session idle before sending continue |
| `MAX_CONSECUTIVE` | 5 | Max consecutive auto-continues before giving up |

## Logs

The plugin logs all activity to the console with `[opencode-auto-continue]` prefix:

```
[opencode-auto-continue] Bad request error in session abc123: Bad Request
[opencode-auto-continue] Session abc123 is idle with pending continue, waiting 2000ms...
[opencode-auto-continue] Sending "continue" to session abc123 (attempt 1/5)
[opencode-auto-continue] Successfully sent "continue" to session abc123
```

## License

MIT
