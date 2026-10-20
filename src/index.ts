import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";

const CONFIG_FILE = "opencode-auto-continue.jsonc";
const MAX_FAILURES = 3;

interface Config {
  enabled: boolean;
  delayMs: number;
  throttleMs: number;
  maxConsecutive: number;
}

const DEFAULTS: Config = {
  enabled: true,
  delayMs: 1_000,
  throttleMs: 5_000,
  maxConsecutive: 0,
};

interface SessionState {
  enabled: boolean;
  suspended: boolean;
  executing: boolean;
  ownPrompt: boolean;
  seenExecution: boolean;
  consecutive: number;
  failures: number;
  lastContinue: number;
  skipScheduleUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }

    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }

    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    out += char;
  }

  return out.replace(/,\s*([}\]])/g, "$1");
}

async function loadConfig(directory: string): Promise<Config> {
  try {
    const raw = await readFile(join(directory, ".opencode", CONFIG_FILE), "utf-8");
    const parsed = JSON.parse(stripJsonc(raw)) as Partial<Config>;
    const amount = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
      delayMs: amount(parsed.delayMs, DEFAULTS.delayMs),
      throttleMs: amount(parsed.throttleMs, DEFAULTS.throttleMs),
      maxConsecutive: Math.floor(amount(parsed.maxConsecutive, DEFAULTS.maxConsecutive)),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export default Plugin.define({
  id: "opencode-auto-continue",

  async setup(ctx) {
    const config = await loadConfig(ctx.location.directory);
    const sessions = new Map<string, SessionState>();
    const controller = new AbortController();

    const stateFor = (sessionID: string): SessionState => {
      let state = sessions.get(sessionID);
      if (!state) {
        state = {
          enabled: config.enabled,
          suspended: false,
          executing: false,
          ownPrompt: false,
          seenExecution: false,
          consecutive: 0,
          failures: 0,
          lastContinue: 0,
          skipScheduleUntil: 0,
        };
        sessions.set(sessionID, state);
      }
      return state;
    };

    const cancel = (state: SessionState) => {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    };

    const resume = async (sessionID: string) => {
      const state = stateFor(sessionID);
      state.timer = undefined;

      if (!state.enabled || state.suspended || state.executing || !state.seenExecution) return;
      if (Date.now() < state.skipScheduleUntil) return;
      if (config.maxConsecutive > 0 && state.consecutive >= config.maxConsecutive) return;
      if (Date.now() - state.lastContinue < config.throttleMs) return;

      // A pending permission means the session is waiting for the user, not stopped.
      const pending = await ctx.permission.list({ sessionID }).catch(() => []);
      if (pending.length > 0) return;

      // Child sessions are driven by their parent, so they are left alone.
      const session = await ctx.session.get({ sessionID }).catch(() => undefined);
      if (!session || session.parentID) return;

      state.consecutive += 1;
      state.lastContinue = Date.now();
      state.ownPrompt = true;
      state.executing = true;

      try {
        await ctx.session.prompt({ sessionID, text: "continue" });
      } catch {
        state.ownPrompt = false;
        state.executing = false;
      }
    };

    const schedule = (sessionID: string) => {
      const state = stateFor(sessionID);
      if (
        !state.enabled ||
        state.suspended ||
        state.executing ||
        state.timer ||
        !state.seenExecution ||
        Date.now() < state.skipScheduleUntil
      ) {
        return;
      }
      state.timer = setTimeout(() => void resume(sessionID), config.delayMs);
    };

    const subscribe = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.idle") {
            const state = stateFor(event.data.sessionID);
            state.executing = false;
            schedule(event.data.sessionID);
            continue;
          }

          if (event.type === "session.execution.started") {
            const state = stateFor(event.data.sessionID);
            cancel(state);
            state.seenExecution = true;
            state.executing = true;

            if (!state.ownPrompt && Date.now() >= state.skipScheduleUntil) {
              state.suspended = false;
              state.consecutive = 0;
              state.failures = 0;
            }
            state.ownPrompt = false;
            continue;
          }

          if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
            const state = stateFor(event.data.sessionID);
            const afterCommand = Date.now() < state.skipScheduleUntil;
            state.skipScheduleUntil = 0;
            state.executing = false;
            state.ownPrompt = false;
            state.failures =
              event.type === "session.execution.failed" ? state.failures + 1 : 0;
            if (!afterCommand && state.failures < MAX_FAILURES) {
              schedule(event.data.sessionID);
            }
            continue;
          }

          if (event.type === "session.execution.interrupted") {
            const state = stateFor(event.data.sessionID);
            cancel(state);
            state.executing = false;
            state.ownPrompt = false;
            if (event.data.reason === "user") state.suspended = true;
          }
        }
      } catch {
        // The stream closes when the plugin unloads.
      }
    };

    void subscribe();

    const runCommand = async ({ sessionID, prompt }: { sessionID: string; prompt: { text: string } }) => {
      const state = stateFor(sessionID);
      // The command output itself is a synthetic turn; it must not trigger a continue.
      state.skipScheduleUntil = Date.now() + 60_000;
      const raw = prompt.text
        .trim()
        .replace(/^\/(?:auto-continue|ac)\b/i, "")
        .trim();
      const subcommand = (raw.split(/\s+/)[0] ?? "").toLowerCase();

      if (subcommand === "on" || subcommand === "off") {
        state.enabled = subcommand === "on";
        state.consecutive = 0;
        state.suspended = false;
        if (!state.enabled) cancel(state);
        await ctx.session.synthetic({
          sessionID,
          text: `Auto-continue ${state.enabled ? "enabled" : "disabled"} for this session.`,
        });
        return;
      }

      if (subcommand === "reset") {
        state.consecutive = 0;
        state.suspended = false;
        await ctx.session.synthetic({ sessionID, text: "Auto-continue counters cleared." });
        return;
      }

      await ctx.session.synthetic({
        sessionID,
        text: [
          `Auto-continue: ${state.enabled ? "on" : "off"}`,
          `Delay: ${config.delayMs}ms`,
          `Throttle: ${config.throttleMs}ms`,
          `Max consecutive: ${config.maxConsecutive === 0 ? "unlimited" : config.maxConsecutive}`,
          `Continues sent: ${state.consecutive}`,
          "",
          "/ac on | off | reset | status",
        ].join("\n"),
      });
    };

    await ctx.command.transform((editor) => {
      const description = "Control automatic continuation (on, off, reset, status)";
      editor.add({ name: "ac", description, execute: runCommand });
      editor.add({ name: "auto-continue", description, execute: runCommand });
    });

    return () => {
      for (const state of sessions.values()) cancel(state);
      controller.abort();
    };
  },
});
