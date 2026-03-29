import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN_NAME = "opencode-auto-continue";
const CONFIG_FILE = `${PLUGIN_NAME}.jsonc`;

/**
 * Default configuration values.
 */
const DEFAULTS = {
  /** Minimum ms between auto-continues for the same session (prevents infinite loops) */
  cooldownMs: 5_000,
  /** Delay after session.idle before sending continue (lets things settle) */
  delayMs: 2_000,
  /** Max consecutive auto-continues per session before giving up */
  maxConsecutive: 5,
  /** Whether the plugin is enabled */
  enabled: true,
} as const;

interface Config {
  cooldownMs: number;
  delayMs: number;
  maxConsecutive: number;
  enabled: boolean;
}

interface SessionState {
  lastErrorTime: number;
  lastContinueTime: number;
  pendingContinue: boolean;
  consecutiveCount: number;
}

function stripJsoncComments(text: string): string {
  let result = "";
  let inString = false;
  let stringChar = "";
  let i = 0;
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\" && i + 1 < text.length) {
        result += text[i] + text[i + 1];
        i += 2;
        continue;
      }
      if (text[i] === stringChar) {
        inString = false;
      }
      result += text[i];
      i++;
    } else {
      if (text[i] === '"' || text[i] === "'") {
        inString = true;
        stringChar = text[i];
        result += text[i];
        i++;
      } else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "/") {
        // Single-line comment — skip to end of line
        while (i < text.length && text[i] !== "\n") i++;
      } else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "*") {
        // Block comment — skip to */
        i += 2;
        while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
        i += 2;
      } else {
        result += text[i];
        i++;
      }
    }
  }
  return result;
}

async function loadConfig(directory: string, log: (msg: string) => void): Promise<Config> {
  const configPath = join(directory, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(stripJsoncComments(raw));
    const config: Config = { ...DEFAULTS };

    if (typeof parsed.cooldownMs === "number") config.cooldownMs = parsed.cooldownMs;
    if (typeof parsed.delayMs === "number") config.delayMs = parsed.delayMs;
    if (typeof parsed.maxConsecutive === "number") config.maxConsecutive = parsed.maxConsecutive;
    if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;

    log(`Loaded config from ${configPath}: ${JSON.stringify(config)}`);
    return config;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      log(`No config file at ${configPath}, using defaults`);
    } else {
      log(`Error reading config from ${configPath}: ${err} — using defaults`);
    }
    return { ...DEFAULTS };
  }
}

function isBadRequestError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  const data = err.data as Record<string, unknown> | undefined;

  // ApiError with statusCode 400
  if (err.name === "APIError" || err.name === "ApiError") {
    if (data?.statusCode === 400) return true;
    if (typeof data?.message === "string" && data.message.toLowerCase().includes("bad request")) return true;
  }

  // UnknownError with "bad request" in message
  if (err.name === "UnknownError") {
    if (typeof data?.message === "string" && data.message.toLowerCase().includes("bad request")) return true;
  }

  return false;
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const err = error as Record<string, unknown>;
  const data = err.data as Record<string, unknown> | undefined;
  return (
    (typeof data?.message === "string" ? data.message : null) ??
    (typeof err.message === "string" ? err.message : null) ??
    String(err.name ?? "unknown")
  );
}

const plugin: Plugin = async ({ client, directory }) => {
  const sessions = new Map<string, SessionState>();

  function log(msg: string) {
    console.log(`[${PLUGIN_NAME}] ${msg}`);
  }

  const config = await loadConfig(directory, log);

  if (!config.enabled) {
    log("Plugin disabled via config");
    return {};
  }

  function getState(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (!state) {
      state = {
        lastErrorTime: 0,
        lastContinueTime: 0,
        pendingContinue: false,
        consecutiveCount: 0,
      };
      sessions.set(sessionID, state);
    }
    return state;
  }

  async function sendContinue(sessionID: string) {
    const state = sessions.get(sessionID);
    if (!state?.pendingContinue) return;

    const now = Date.now();
    if (now - state.lastContinueTime < config.cooldownMs) {
      log(`Cooldown active for session ${sessionID}, skipping`);
      return;
    }

    if (state.consecutiveCount >= config.maxConsecutive) {
      log(`Max consecutive auto-continues (${config.maxConsecutive}) reached for session ${sessionID}, giving up`);
      state.pendingContinue = false;
      return;
    }

    state.lastContinueTime = now;
    state.consecutiveCount++;
    state.pendingContinue = false;

    log(`Sending "continue" to session ${sessionID} (attempt ${state.consecutiveCount}/${config.maxConsecutive})`);

    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text" as const, text: "continue" }],
        },
      });
      log(`Successfully sent "continue" to session ${sessionID}`);
    } catch (err) {
      log(`Failed to send "continue" to session ${sessionID}: ${err}`);
    }
  }

  return {
    event: async ({ event }) => {
      // ── session.error: detect bad request errors ──
      if (event.type === "session.error") {
        const props = event.properties as {
          sessionID?: string;
          error?: unknown;
        };
        const { sessionID, error } = props;
        if (!sessionID) return;

        if (isBadRequestError(error)) {
          log(`Bad request error in session ${sessionID}: ${errorMessage(error)}`);

          const state = getState(sessionID);
          state.lastErrorTime = Date.now();
          state.pendingContinue = true;
        }
      }

      // ── message.updated: detect bad request errors on assistant messages ──
      if (event.type === "message.updated") {
        const props = event.properties as {
          info?: { sessionID?: string; role?: string; error?: unknown };
        };
        const info = props.info;
        if (!info?.sessionID || info.role !== "assistant") return;

        if (isBadRequestError(info.error)) {
          log(`Bad request error on assistant message in session ${info.sessionID}: ${errorMessage(info.error)}`);

          const state = getState(info.sessionID);
          state.lastErrorTime = Date.now();
          state.pendingContinue = true;
        }
      }

      // ── session.idle: send continue if pending ──
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID?: string };
        const sessionID = props.sessionID;
        if (!sessionID) return;

        const state = sessions.get(sessionID);
        if (state?.pendingContinue) {
          log(`Session ${sessionID} is idle with pending continue, waiting ${config.delayMs}ms...`);
          setTimeout(() => sendContinue(sessionID), config.delayMs);
        }
      }

      // ── Reset consecutive counter on successful completion ──
      if (event.type === "message.updated") {
        const props = event.properties as {
          info?: {
            sessionID?: string;
            role?: string;
            error?: unknown;
            metadata?: { done?: boolean };
          };
        };
        const info = props.info;
        if (info?.sessionID && info.role === "assistant" && info.metadata?.done && !info.error) {
          const state = sessions.get(info.sessionID);
          if (state && state.consecutiveCount > 0) {
            log(`Session ${info.sessionID} completed successfully, resetting consecutive counter`);
            state.consecutiveCount = 0;
          }
        }
      }
    },
  };
};

export default plugin;
