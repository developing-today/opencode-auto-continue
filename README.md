<p align="center">
  <img src=".github/assets/logo.svg" width="112" height="112" alt="opencode-auto-continue logo">
</p>

<h1 align="center">opencode-auto-continue</h1>

<p align="center">Keeps an OpenCode session moving when the agent stops.</p>

<p align="center">
  <img alt="OpenCode 2" src="https://img.shields.io/badge/OpenCode-2.x-58a6ff">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-3fb950">
</p>

## Why

Every OpenCode turn ends with the agent idle. On a long task that means either noticing the stop and typing `continue`, or leaving the work half done. This plugin sends the continue for you once the execution has genuinely finished.

## What it does

1. Watches for an execution to finish (`session.execution.succeeded` or `session.execution.failed`).
2. Waits `delayMs` so a prompt already queued by the user starts first.
3. Sends `continue`.
4. Repeats when the next execution finishes.

It stays out of the way when:

- the user interrupted the session — it resumes only after the user starts a new turn;
- a permission request is waiting for an answer;
- the session is a child session created by a subagent;
- the turn came from a `/ac` command rather than the agent;
- three executions in a row have failed;
- the consecutive limit or throttle has been reached.

## Requirements

- OpenCode 2.
- A model and provider configured in OpenCode.
- The plugin installed in a project or in the global plugin directory.

## Installation

Add the package to the `plugins` array in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    "opencode-auto-continue@https://github.com/developing-today/opencode-auto-continue/archive/refs/tags/latest.tar.gz"
  ]
}
```

Restart the OpenCode service so the plugin is loaded. Restarting only the terminal interface does not reload plugins:

```bash
opencode service restart
```

### From source

Build the package and point a local plugin file at the result:

```bash
git clone https://github.com/developing-today/opencode-auto-continue.git
cd opencode-auto-continue
npm install
npm run build
```

Create `~/.config/opencode/plugins/opencode-auto-continue.js`:

```js
export { default } from "file:///absolute/path/to/opencode-auto-continue/dist/index.js";
```

The file path must be absolute.

## Commands

`/auto-continue` and `/ac` are equivalent.

| Command | Description |
|---------|-------------|
| `/ac` | Show current settings and state |
| `/ac status` | Same as `/ac` |
| `/ac on` | Enable continuation for the current session |
| `/ac off` | Disable continuation for the current session |
| `/ac reset` | Clear the consecutive counter and allow continuing again |

Session settings live in memory and end with the session. Use the config file to change the defaults.

## Configuration

Create `opencode-auto-continue.jsonc` in the project's `.opencode/` directory. Every field is optional.

```jsonc
{
  // Send continue this long after an execution finishes.
  "delayMs": 1000,

  // Minimum time between two auto-continues in the same session.
  "throttleMs": 5000,

  // Stop after this many continues without a user turn. 0 means no limit.
  "maxConsecutive": 0,

  // Set false to disable the plugin without removing it.
  "enabled": true
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `delayMs` | number | `1000` | Delay after an execution finishes before sending `continue` |
| `throttleMs` | number | `5000` | Minimum time between auto-continues in one session |
| `maxConsecutive` | number | `0` | Consecutive continue limit, `0` for unlimited |
| `enabled` | boolean | `true` | Default state for new sessions |

Invalid values are clamped to finite, non-negative numbers.

## Safety limits

- **Three failed executions in a row stop the plugin** for that session instead of retrying a broken provider. A successful turn or a user message resets the count.
- **The `/ac` command's own turn does not trigger a continue**, so checking status cannot start a loop.
- **Pending timers are cleared when the plugin unloads**, so a disposed plugin cannot send a prompt.
- **`maxConsecutive`** caps a long autonomous run. `0` means unlimited, which is useful for unattended work and expensive if left running.

## Stopping it

Press Esc to interrupt the current turn. The plugin does not restart the session until you send a message yourself. Run `/ac off` to disable it for the rest of the session, or set `"enabled": false` in the config file for every session.

## Troubleshooting

**The plugin is not listed.** Check `opencode plugin list` and restart the service. A local plugin file must export the built module and use an absolute path.

**The session never resumes.** Confirm the session produced `session.execution.succeeded` events. This plugin does not wait for `session.idle`: OpenCode 2 does not emit it.

**The `/ac` commands are missing.** The plugin registers them, but the terminal interface caches its command list. Close and reopen the interface after the service restart.

**It continues when you did not want it to.** Run `/ac off`, press Esc, or set `maxConsecutive` to a finite number.

## Development

```bash
npm install
npm run build
npx tsc --noEmit
```

The package targets the OpenCode 2 plugin API and depends on `@opencode/plugin`.

## License

MIT.
