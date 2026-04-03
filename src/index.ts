import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN_NAME = "opencode-auto-continue";
const CONFIG_DIR = ".opencode";
const CONFIG_FILE = `${PLUGIN_NAME}.jsonc`;
const GITHUB_REPO = "developing-today/opencode-auto-continue";
const GITHUB_API_COMMITS = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
const GITHUB_API_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/latest`;

// ─── Content hash from bun.lock ─────────────────────────────────────────────

function readContentHashFromLock(raw: string): string | null {
  const pattern = new RegExp(`"${PLUGIN_NAME}":\\s*\\[.*?,\\s*"(sha512-[^"]+)"`);
  const match = raw.match(pattern);
  return match?.[1] ?? null;
}

function shortHash(hash: string): string {
  // "sha512-+fPJGSdlt..." → first 12 chars after "sha512-"
  const body = hash.startsWith("sha512-") ? hash.slice(7) : hash;
  return body.slice(0, 12);
}

async function readBunLockHash(): Promise<string | null> {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const lockPath = join(home, ".cache", "opencode", "bun.lock");
    const raw = await readFile(lockPath, "utf-8");
    return readContentHashFromLock(raw);
  } catch {
    return null;
  }
}

// ─── Default retryable error patterns ───────────────────────────────────────
// Matched case-insensitively against "${errorName}: ${errorMessage}".
// Override via config file's "errorPatterns" array.

const DEFAULT_ERROR_PATTERNS: string[] = [
  // API / provider errors (from DB: 63 occurrences)
  "bad request",
  "reasoning_opaque",
  "prefill",
  "SSE read timed out",
  "DecimalError",
  // Context / compaction errors (from DB: 7 occurrences)
  "ContextOverflowError",
  "too large to compact",
  // Tool execution errors (from GitHub issues)
  "Invalid diff",
  "Tool execution aborted",
  "JSON parsing failed",
  "Invalid input for tool",
  "tried to call unavailable tool",
  "finding less tool calls",
  "tool_use ids were found without tool_result",
  // Connection errors (mid-stream, not initial connect)
  "ECONNREFUSED",
  "ECONNRESET",
  // Stream / timeout errors
  "idle timeout",
  "no data received",
  // Type / validation errors
  "expected string, received undefined",
];

const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  // User-initiated abort — never auto-continue
  "MessageAbortedError",
  "operation was aborted",
];

/**
 * Default configuration values.
 */
const DEFAULTS: Config = {
  /** Minimum ms between auto-continues for the same session */
  throttleMs: 5_000,
  /** Delay after session.idle before sending continue */
  delayMs: 500,
  /** Max consecutive auto-continues per session before giving up (0 = unlimited) */
  maxConsecutive: 5,
  /** Whether the plugin is enabled */
  enabled: true,
  /** Minimum ms between remote version checks */
  updateThrottleMs: 30_000,
  /** Error patterns to auto-continue on (case-insensitive substrings) */
  errorPatterns: DEFAULT_ERROR_PATTERNS,
  /** Error patterns to NEVER auto-continue on (checked first, case-insensitive substrings) */
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
};

interface Config {
  throttleMs: number;
  delayMs: number;
  maxConsecutive: number;
  enabled: boolean;
  updateThrottleMs: number;
  errorPatterns: string[];
  excludePatterns: string[];
}

interface SessionState {
  lastErrorTime: number;
  lastContinueTime: number;
  pendingContinue: boolean;
  consecutiveCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJsonc(text: string): unknown {
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
        while (i < text.length && text[i] !== "\n") i++;
      } else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
        i += 2;
      } else {
        result += text[i];
        i++;
      }
    }
  }
  // Strip trailing commas before } or ]
  result = result.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(result);
}

async function loadConfig(directory: string, log: (msg: string) => void): Promise<Config> {
  const configPath = join(directory, CONFIG_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseJsonc(raw) as Record<string, unknown>;
    const config: Config = { ...DEFAULTS };

    if (typeof parsed.throttleMs === "number") config.throttleMs = parsed.throttleMs;
    if (typeof parsed.delayMs === "number") config.delayMs = parsed.delayMs;
    if (typeof parsed.maxConsecutive === "number") config.maxConsecutive = parsed.maxConsecutive;
    if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
    if (typeof parsed.updateThrottleMs === "number") config.updateThrottleMs = parsed.updateThrottleMs;
    if (Array.isArray(parsed.errorPatterns)) {
      config.errorPatterns = parsed.errorPatterns.filter((p): p is string => typeof p === "string");
    }
    if (Array.isArray(parsed.excludePatterns)) {
      config.excludePatterns = parsed.excludePatterns.filter((p): p is string => typeof p === "string");
    }

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

function isRetryableError(error: unknown, config: Config): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;
  const data = err.data as Record<string, unknown> | undefined;
  const name = typeof err.name === "string" ? err.name : "";
  const message =
    (typeof data?.message === "string" ? data.message : null) ??
    (typeof err.message === "string" ? err.message : "");

  // Build a single matchable string: "ErrorName: error message text"
  const matchStr = `${name}: ${message}`.toLowerCase();

  // Exclude patterns checked first — if any match, never retry
  for (const pattern of config.excludePatterns) {
    if (matchStr.includes(pattern.toLowerCase())) return false;
  }

  // Error patterns — if any match, retry
  for (const pattern of config.errorPatterns) {
    if (matchStr.includes(pattern.toLowerCase())) return true;
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

// ─── Plugin ─────────────────────────────────────────────────────────────────

const plugin: Plugin = async ({ client, directory }) => {
  const sessions = new Map<string, SessionState>();
  const sessionConfigs = new Map<string, Partial<Config>>();

  // Silent log — console.log leaks into the TUI as raw terminal output
  function log(_msg: string) {
    // intentionally silent
  }

  // Global config — loaded from file, mutated by /auto-continue global commands
  const globalConfig = await loadConfig(directory, log);

  // Snapshot content hash at load time
  const loadedHash = await readBunLockHash();
  log(`Loaded with content hash: ${loadedHash ?? "unknown"}`);

  // Cached remote version check (debounced)
  let lastRemoteCheck = 0;
  let cachedRemoteHash: string | null = null;
  let cachedCommitSha: string | null = null;

  /** Check whether the cached module has been cleared (by global update in any session) */
  async function isCacheCleared(): Promise<boolean> {
    try {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      const cachedMod = join(home, ".cache", "opencode", "node_modules", PLUGIN_NAME);
      await access(cachedMod);
      return false; // exists → not cleared
    } catch {
      return true; // doesn't exist → cleared
    }
  }

  async function fetchLatestHash(): Promise<{ hash: string | null; commitSha: string | null }> {
    const cfg = globalConfig;
    const now = Date.now();
    if (now - lastRemoteCheck < cfg.updateThrottleMs) {
      return { hash: cachedRemoteHash, commitSha: cachedCommitSha };
    }
    try {
      const response = await fetch(GITHUB_API_RELEASE, {
        headers: { "User-Agent": PLUGIN_NAME },
      });
      if (!response.ok) return { hash: cachedRemoteHash, commitSha: cachedCommitSha };
      const release = (await response.json()) as { body?: string };
      const body = release.body || "";
      const bodyLines = body.split("\n");
      cachedRemoteHash = bodyLines[0]?.startsWith("sha512-") ? bodyLines[0].trim() : null;
      const commitLine = bodyLines.find((l: string) => l.startsWith("Commit: "));
      cachedCommitSha = commitLine?.replace("Commit: ", "").trim() ?? null;
      lastRemoteCheck = now;
    } catch {
      // Network failure — keep stale cache
    }
    return { hash: cachedRemoteHash, commitSha: cachedCommitSha };
  }
  // Version info for display
  async function versionInfo(checkRemote = false): Promise<string> {
    const loadedShort = loadedHash ? shortHash(loadedHash) : "unknown";
    const currentHash = await readBunLockHash();
    const currentShort = currentHash ? shortHash(currentHash) : "unknown";

    const lines: string[] = [];

    // Base version
    lines.push(loadedShort);

    // Local: loaded vs current bun.lock
    const localUpdated = loadedHash && currentHash && loadedHash !== currentHash;
    if (localUpdated) {
      lines.push(`  ⚠️  *needs opencode reload* (bun: ${currentShort})`);
    }

    // Remote check (only when requested — status, help with /ac)
    if (checkRemote) {
      const { hash: remoteHash, commitSha } = await fetchLatestHash();
      const remoteShort = remoteHash ? shortHash(remoteHash) : null;
      const shortSha = commitSha?.substring(0, 7) ?? "";

      if (remoteHash && remoteShort) {
        const matchesLoaded = loadedHash === remoteHash;
        const matchesCurrent = currentHash === remoteHash;
        const cacheCleared = await isCacheCleared();

        if (matchesLoaded && matchesCurrent) {
          // All same — nothing to add
        } else if (!localUpdated && !matchesLoaded) {
          // loaded == current, remote is different → update available
          if (cacheCleared) {
            lines.push(`  🆕 Update ready: ${remoteShort}${shortSha ? ` (${shortSha})` : ""}`);
            lines.push(`     Restart opencode to load the new version`);
          } else {
            lines.push(`  🆕 Update available: ${remoteShort}${shortSha ? ` (${shortSha})` : ""}`);
            lines.push(`     Run /ac global update then restart opencode`);
          }
        } else if (localUpdated && matchesCurrent) {
          // Already updated locally, matches remote — just needs reload (already shown above)
        } else if (localUpdated && !matchesCurrent && !matchesLoaded) {
          // All three differ: loaded ≠ current ≠ remote
          if (cacheCleared) {
            lines.push(`  🆕 Newer version available: ${remoteShort}${shortSha ? ` (${shortSha})` : ""}`);
            lines.push(`     Pending reload has ${currentShort}, latest is ${remoteShort}`);
            lines.push(`     Restart opencode to load the new version`);
          } else {
            lines.push(`  🆕 Newer version available: ${remoteShort}${shortSha ? ` (${shortSha})` : ""}`);
            lines.push(`     Pending reload has ${currentShort}, latest is ${remoteShort}`);
            lines.push(`     Run /ac global update then restart opencode`);
          }
        }
      }
    }

    return lines.join("\n");
  }

  // Merge global config with per-session overrides
  function getEffectiveConfig(sessionID?: string): Config {
    if (!sessionID) return globalConfig;
    const overrides = sessionConfigs.get(sessionID);
    if (!overrides) return globalConfig;
    return { ...globalConfig, ...overrides };
  }

  // Send a message that appears in chat but does NOT trigger the LLM
  async function sendMessage(sessionID: string, text: string) {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text" as const, text, ignored: true }],
      },
    });
  }

  // Write current globalConfig to disk
  async function writeGlobalConfig() {
    const configPath = join(directory, CONFIG_DIR, CONFIG_FILE);
    // Omit pattern arrays from disk if they're still the defaults
    const toWrite: Record<string, unknown> = {
      throttleMs: globalConfig.throttleMs,
      delayMs: globalConfig.delayMs,
      maxConsecutive: globalConfig.maxConsecutive,
      enabled: globalConfig.enabled,
      updateThrottleMs: globalConfig.updateThrottleMs,
    };
    if (globalConfig.errorPatterns !== DEFAULT_ERROR_PATTERNS) {
      toWrite.errorPatterns = globalConfig.errorPatterns;
    }
    if (globalConfig.excludePatterns !== DEFAULT_EXCLUDE_PATTERNS) {
      toWrite.excludePatterns = globalConfig.excludePatterns;
    }
    const content = JSON.stringify(toWrite, null, 2) + "\n";
    await writeFile(configPath, content, "utf-8");
    log(`Wrote global config to ${configPath}`);
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

    const config = getEffectiveConfig(sessionID);
    const now = Date.now();

    if (now - state.lastContinueTime < config.throttleMs) {
      const remaining = config.throttleMs - (now - state.lastContinueTime);
      log(`Throttle active for session ${sessionID}, ${remaining}ms remaining, skipping`);
      return;
    }

    if (config.maxConsecutive > 0 && state.consecutiveCount >= config.maxConsecutive) {
      log(`Max consecutive (${config.maxConsecutive}) reached for ${sessionID}, giving up`);
      state.pendingContinue = false;
      return;
    }

    state.lastContinueTime = now;
    state.consecutiveCount++;
    state.pendingContinue = false;

    const maxLabel = config.maxConsecutive > 0 ? `${config.maxConsecutive}` : "∞";
    log(`Sending "continue" to ${sessionID} (attempt ${state.consecutiveCount}/${maxLabel})`);

    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text" as const, text: "continue" }],
        },
      });
      log(`Successfully sent "continue" to ${sessionID}`);
    } catch (err) {
      log(`Failed to send "continue" to ${sessionID}: ${err}`);
    }
  }

  // ── Command UI helpers ──────────────────────────────────────────────────

  function overrideLines(overrides: Partial<Config>): string[] {
    const parts: string[] = [];
    if (overrides.enabled !== undefined) parts.push(`enabled: ${overrides.enabled}`);
    if (overrides.throttleMs !== undefined) parts.push(`throttle: ${overrides.throttleMs}ms`);
    if (overrides.delayMs !== undefined) parts.push(`delay: ${overrides.delayMs}ms`);
    if (overrides.maxConsecutive !== undefined) parts.push(`max: ${overrides.maxConsecutive === 0 ? "unlimited" : overrides.maxConsecutive}`);
    if (overrides.updateThrottleMs !== undefined) parts.push(`update-throttle: ${overrides.updateThrottleMs}ms`);
    const globalParts = [
      `enabled: ${globalConfig.enabled}`,
      `throttle: ${globalConfig.throttleMs}ms`,
      `delay: ${globalConfig.delayMs}ms`,
      `max: ${globalConfig.maxConsecutive === 0 ? "unlimited" : globalConfig.maxConsecutive}`,
    ];
    if (globalConfig.updateThrottleMs !== DEFAULTS.updateThrottleMs) {
      globalParts.push(`update-throttle: ${globalConfig.updateThrottleMs}ms`);
    }
    return ["", `  Session overrides: ${parts.join(" · ")}`, `  Global defaults:   ${globalParts.join(" · ")}`];
  }

  async function configSummaryLines(sessionID: string, checkRemote = false): Promise<string[]> {
    const cfg = getEffectiveConfig(sessionID);
    const overrides = sessionConfigs.get(sessionID);
    const status = cfg.enabled ? "✅ enabled" : "❌ disabled";
    const ver = await versionInfo(checkRemote);
    const maxDisplay = cfg.maxConsecutive === 0 ? "unlimited" : String(cfg.maxConsecutive);
    const summaryParts = [`Throttle: ${cfg.throttleMs}ms`, `Delay: ${cfg.delayMs}ms`, `Max: ${maxDisplay}`];
    if (cfg.updateThrottleMs !== DEFAULTS.updateThrottleMs) {
      summaryParts.push(`Update: ${cfg.updateThrottleMs}ms`);
    }
    const lines = [`  Status: ${status} · ${ver}`, `  ${summaryParts.join(" · ")}`];
    if (overrides && Object.keys(overrides).length > 0) {
      lines.push(...overrideLines(overrides));
    }
    return lines;
  }

  async function helpText(sessionID: string): Promise<string> {
    const lines = [
      "╭──────────────────────────────────────────╮",
      "│       Auto-Continue Commands             │",
      "╰──────────────────────────────────────────╯",
      "",
      ...(await configSummaryLines(sessionID, true)),
    ];

    lines.push(
      "",
      "  /auto-continue on|off              Enable/disable (session)",
      "  /auto-continue throttle <ms>         Set retry throttle (session)",
      "  /auto-continue delay <ms>          Set delay (session)",
      "  /auto-continue max <n>             Set max retries (session, 0=unlimited)",
      "  /auto-continue update-throttle <ms>  Set update throttle (session)",
      "  /auto-continue status              Show current settings",
      "  /auto-continue patterns            Show active error patterns",
      "  /auto-continue reload              Reload global config from disk",
      "  /auto-continue reset               Clear session overrides",
      "  /auto-continue global <cmd>        Persist setting to config file",
      "  /auto-continue global update       Clear cache to fetch latest version",
      "  /auto-continue help                Show this help",
      "",
      "  Alias: /ac (same commands, e.g. /ac status)",
    );
    return lines.join("\n");
  }

  async function statusText(sessionID: string): Promise<string> {
    const cfg = getEffectiveConfig(sessionID);
    const overrides = sessionConfigs.get(sessionID);
    const state = sessions.get(sessionID);
    const ver = await versionInfo(true);
    const lines = [
      "╭──────────────────────────────────────────╮",
      "│       Auto-Continue Status               │",
      "╰──────────────────────────────────────────╯",
      "",
      `  Version:         ${ver}`,
      `  Enabled:         ${cfg.enabled ? "✅ yes" : "❌ no"}`,
      `  Throttle:        ${cfg.throttleMs}ms`,
      `  Delay:           ${cfg.delayMs}ms`,
      `  Max Retries:     ${cfg.maxConsecutive === 0 ? "unlimited (0)" : cfg.maxConsecutive}`,
      `  Update throttle: ${cfg.updateThrottleMs}ms`,
    ];

    if (overrides && Object.keys(overrides).length > 0) {
      lines.push("");
      lines.push("  ── Session Overrides ──");
      if (overrides.enabled !== undefined)
        lines.push(
          `  Enabled:         ${overrides.enabled ? "✅ yes" : "❌ no"}  (global: ${globalConfig.enabled ? "yes" : "no"})`,
        );
      if (overrides.throttleMs !== undefined)
        lines.push(`  Throttle:        ${overrides.throttleMs}ms  (global: ${globalConfig.throttleMs}ms)`);
      if (overrides.delayMs !== undefined)
        lines.push(`  Delay:           ${overrides.delayMs}ms  (global: ${globalConfig.delayMs}ms)`);
      if (overrides.maxConsecutive !== undefined)
        lines.push(`  Max Retries:     ${overrides.maxConsecutive === 0 ? "unlimited (0)" : overrides.maxConsecutive}  (global: ${globalConfig.maxConsecutive === 0 ? "unlimited (0)" : globalConfig.maxConsecutive})`);
      if (overrides.updateThrottleMs !== undefined)
        lines.push(`  Update throttle: ${overrides.updateThrottleMs}ms  (global: ${globalConfig.updateThrottleMs}ms)`);
    }

    const checkRemaining = lastRemoteCheck > 0
      ? Math.max(0, cfg.updateThrottleMs - (Date.now() - lastRemoteCheck))
      : null;

    const retryRemaining = state?.lastContinueTime && state.lastContinueTime > 0
      ? Math.max(0, cfg.throttleMs - (Date.now() - state.lastContinueTime))
      : null;

    lines.push(
      "",
      "  ── Session State ──",
    );
    if (retryRemaining !== null) {
      lines.push(`  Retry cooldown:      ${retryRemaining > 0 ? `${retryRemaining}ms` : "ready"}`);
    }
    lines.push(
      `  Consecutive retries: ${state?.consecutiveCount ?? 0}`,
      `  Pending continue:    ${state?.pendingContinue ? "yes" : "no"}`,
    );
    if (checkRemaining !== null) {
      lines.push(`  Update cooldown:     ${checkRemaining > 0 ? `${checkRemaining}ms` : "ready"}`);
    }
    lines.push(
      "",
      "  ── Global Config ──",
      `  ${JSON.stringify({ ...globalConfig, errorPatterns: `[${globalConfig.errorPatterns.length} patterns]`, excludePatterns: `[${globalConfig.excludePatterns.length} patterns]` })}`,
    );

    const isCustomPatterns = globalConfig.errorPatterns !== DEFAULT_ERROR_PATTERNS;
    const isCustomExcludes = globalConfig.excludePatterns !== DEFAULT_EXCLUDE_PATTERNS;
    lines.push(
      "",
      `  ── Error Patterns (${cfg.errorPatterns.length} match, ${cfg.excludePatterns.length} exclude) ──`,
      `  Patterns: ${isCustomPatterns ? "custom" : "default"}  ·  Excludes: ${isCustomExcludes ? "custom" : "default"}`,
      "  Run /ac patterns for full list",
    );
    return lines.join("\n");
  }

  // ── Hooks ───────────────────────────────────────────────────────────────

  // Extracted command handler shared by /auto-continue and /ac
  async function handleCommand(input: any) {
    const args: string[] = (input.arguments || "").trim().split(/\s+/).filter(Boolean);
    const subcmd = args[0]?.toLowerCase() || "";
    const sessionID: string = input.sessionID;

    // ── Help (default) ──
    if (!subcmd || subcmd === "help") {
      await sendMessage(sessionID, await helpText(sessionID));
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── On / Off ──
    if (subcmd === "on" || subcmd === "off") {
      const enabled = subcmd === "on";
      const overrides = sessionConfigs.get(sessionID) || {};
      overrides.enabled = enabled;
      sessionConfigs.set(sessionID, overrides);
      await sendMessage(sessionID, `Auto-continue ${enabled ? "✅ enabled" : "❌ disabled"} for this session.`);
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Throttle / Delay / Max / Check-Interval ──
    if (subcmd === "throttle" || subcmd === "delay" || subcmd === "max" || subcmd === "update-throttle") {
      const value = parseInt(args[1], 10);
      if (isNaN(value) || value < 0) {
        await sendMessage(sessionID, `❌ Invalid value. Usage: /auto-continue ${subcmd} <number>`);
        throw new Error("__AUTO_CONTINUE_HANDLED__");
      }

      const overrides = sessionConfigs.get(sessionID) || {};
      const keyMap: Record<string, keyof Config> = {
        throttle: "throttleMs",
        delay: "delayMs",
        max: "maxConsecutive",
        "update-throttle": "updateThrottleMs",
      };
      (overrides as any)[keyMap[subcmd]] = value;
      sessionConfigs.set(sessionID, overrides);

      const label =
        subcmd === "throttle"
          ? "Throttle"
          : subcmd === "delay"
            ? "Delay"
            : subcmd === "max"
              ? "Max consecutive"
              : "Update throttle";
      const unit = subcmd === "max" ? "" : "ms";
      await sendMessage(sessionID, `${label} set to ${value}${unit} for this session.`);
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Status ──
    if (subcmd === "status") {
      await sendMessage(sessionID, await statusText(sessionID));
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Patterns (show all active error patterns) ──
    if (subcmd === "patterns") {
      const cfg = getEffectiveConfig(sessionID);
      const isCustom = cfg.errorPatterns !== DEFAULT_ERROR_PATTERNS;
      const isCustomExcl = cfg.excludePatterns !== DEFAULT_EXCLUDE_PATTERNS;
      const lines = [
        "╭──────────────────────────────────────────╮",
        "│       Error Patterns                     │",
        "╰──────────────────────────────────────────╯",
        "",
        `  ── Match Patterns (${cfg.errorPatterns.length}) ${isCustom ? "[custom]" : "[default]"} ──`,
        ...cfg.errorPatterns.map(p => `    • ${p}`),
        "",
        `  ── Exclude Patterns (${cfg.excludePatterns.length}) ${isCustomExcl ? "[custom]" : "[default]"} ──`,
        ...cfg.excludePatterns.map(p => `    ✕ ${p}`),
        "",
        "  Matching: case-insensitive substring against \"ErrorName: message\"",
        "  Excludes are checked first. Override via config file.",
      ];
      await sendMessage(sessionID, lines.join("\n"));
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Reload (re-read global config from disk) ──
    if (subcmd === "reload") {
      const configPath = join(directory, CONFIG_DIR, CONFIG_FILE);
      let fileExists = false;
      let rawContents = "";
      try {
        rawContents = await readFile(configPath, "utf-8");
        fileExists = true;
      } catch {
        // File doesn't exist
      }

      const reloaded = await loadConfig(directory, log);
      Object.assign(globalConfig, reloaded);

      const lines: string[] = [];
      if (fileExists) {
        lines.push(
          "Auto-continue global config reloaded",
          `  From: ${configPath}`,
          `  Contents: ${rawContents.trim()}`,
        );
      } else {
        lines.push(
          "Auto-continue global config reloaded",
          `  No ${CONFIG_FILE} found at ${configPath} — using defaults`,
        );
      }

      lines.push("", ...(await configSummaryLines(sessionID)));

      await sendMessage(sessionID, lines.join("\n"));

      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Reset (clear session overrides) ──
    if (subcmd === "reset") {
      sessionConfigs.delete(sessionID);
      await sendMessage(sessionID, "Session overrides cleared. Using global config.");
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Global ──
    if (subcmd === "global") {
      const globalSub = args[1]?.toLowerCase() || "";

      // ── Global Update: clear cached module so next restart fetches latest ──
      if (globalSub === "update") {
        try {
          await sendMessage(sessionID, "Checking for updates...");

          // 1. Fetch latest release metadata — has both commit SHA and content hash
          const response = await fetch(GITHUB_API_RELEASE, {
            headers: { "User-Agent": PLUGIN_NAME },
          });
          if (!response.ok) {
            await sendMessage(sessionID, `❌ GitHub API returned ${response.status}: ${response.statusText}`);
            throw new Error("__AUTO_CONTINUE_HANDLED__");
          }
          const release = (await response.json()) as { body?: string; tag_name?: string };
          const body = release.body || "";
          const bodyLines = body.split("\n");

          // First line is the sha512 SRI hash, "Commit: <sha>" is on a later line
          const remoteHash = bodyLines[0]?.startsWith("sha512-") ? bodyLines[0].trim() : null;
          const commitLine = bodyLines.find((l: string) => l.startsWith("Commit: "));
          const commitSha = commitLine?.replace("Commit: ", "").trim();
          const shortSha = commitSha?.substring(0, 7) ?? "unknown";
          const remoteShort = remoteHash ? shortHash(remoteHash) : "unknown";

          // Update the shared debounce cache so versionInfo doesn't show stale data
          cachedRemoteHash = remoteHash;
          cachedCommitSha = commitSha ?? null;
          lastRemoteCheck = Date.now();

          // Compare with currently loaded hash
          const currentShort = loadedHash ? shortHash(loadedHash) : "unknown";
          const isUpToDate = loadedHash && remoteHash && loadedHash === remoteHash;

          if (isUpToDate) {
            await sendMessage(
              sessionID,
              [`✅ Already up to date.`, `   Commit: ${shortSha} · Hash: ${currentShort}`].join("\n"),
            );
            throw new Error("__AUTO_CONTINUE_HANDLED__");
          }

          // 2. Clear OpenCode's cached module and dependency entry so it re-installs on restart
          const home = process.env.HOME || process.env.USERPROFILE || "";
          const opencodeCacheDir = join(home, ".cache", "opencode");
          let cacheCleared = false;

          // Remove the cached node_modules entry
          try {
            const cachedMod = join(opencodeCacheDir, "node_modules", PLUGIN_NAME);
            await rm(cachedMod, { recursive: true, force: true });
            cacheCleared = true;
          } catch {
            // Not critical if missing
          }

          // Remove from OpenCode's cache package.json so it triggers reinstall
          try {
            const pkgJsonPath = join(opencodeCacheDir, "package.json");
            const raw = await readFile(pkgJsonPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed.dependencies?.[PLUGIN_NAME]) {
              delete parsed.dependencies[PLUGIN_NAME];
              await writeFile(pkgJsonPath, JSON.stringify(parsed, null, 2), "utf-8");
            }
          } catch {
            // Not critical
          }

          // Remove bun.lock to avoid stale resolution
          try {
            await rm(join(opencodeCacheDir, "bun.lock"), { force: true });
          } catch {
            // Not critical
          }

          // Also clear bun's own install cache
          try {
            const bunCacheDir = join(home, ".cache", ".bun", "install", "cache");
            const entries = await readdir(bunCacheDir);
            for (const entry of entries) {
              if (entry.includes("developing-today-opencode-auto-continue") || entry === PLUGIN_NAME) {
                await rm(join(bunCacheDir, entry), { recursive: true, force: true });
              }
            }
          } catch {
            // Cache dir might not exist — not critical
          }

          const msg = [
            `✅ Update available: ${currentShort} → ${remoteShort}`,
            `   Commit: ${shortSha}`,
            cacheCleared ? "   Cleared cached module." : "   No cached module found.",
            "",
            "   Restart opencode to load the new version.",
          ];
          await sendMessage(sessionID, msg.join("\n"));
        } catch (err: unknown) {
          if (err instanceof Error && err.message === "__AUTO_CONTINUE_HANDLED__") throw err;
          await sendMessage(sessionID, `❌ Update failed: ${err}`);
        }
        throw new Error("__AUTO_CONTINUE_HANDLED__");
      }

      if (globalSub === "on" || globalSub === "off") {
        globalConfig.enabled = globalSub === "on";
        await writeGlobalConfig();
        await sendMessage(
          sessionID,
          `Global config: auto-continue ${globalSub === "on" ? "✅ enabled" : "❌ disabled"}. Written to ${CONFIG_FILE}.`,
        );
        throw new Error("__AUTO_CONTINUE_HANDLED__");
      }

      if (globalSub === "throttle" || globalSub === "delay" || globalSub === "max" || globalSub === "update-throttle") {
        const value = parseInt(args[2], 10);
        if (isNaN(value) || value < 0) {
          await sendMessage(sessionID, `❌ Invalid value. Usage: /auto-continue global ${globalSub} <number>`);
          throw new Error("__AUTO_CONTINUE_HANDLED__");
        }

        const keyMap: Record<string, keyof Config> = {
          throttle: "throttleMs",
          delay: "delayMs",
          max: "maxConsecutive",
          "update-throttle": "updateThrottleMs",
        };
        (globalConfig as any)[keyMap[globalSub]] = value;
        await writeGlobalConfig();

        const label =
          globalSub === "throttle"
            ? "Throttle"
            : globalSub === "delay"
              ? "Delay"
              : globalSub === "max"
                ? "Max consecutive"
                : "Update throttle";
        const unit = globalSub === "max" ? "" : "ms";
        await sendMessage(sessionID, `Global config: ${label} set to ${value}${unit}. Written to ${CONFIG_FILE}.`);
        throw new Error("__AUTO_CONTINUE_HANDLED__");
      }

      // Global help (no recognized subcommand)
      const text = [
        "Usage: /auto-continue global <subcommand>",
        "",
        "  on|off              Enable/disable globally",
        "  throttle <ms>       Set global retry throttle",
        "  delay <ms>          Set global delay",
        "  max <n>             Set global max retries (0=unlimited)",
        "  update-throttle <ms> Set global update throttle",
        "  update              Clear cache to fetch latest version",
      ].join("\n");
      await sendMessage(sessionID, text);
      throw new Error("__AUTO_CONTINUE_HANDLED__");
    }

    // ── Unknown ──
    await sendMessage(
      sessionID,
      `❌ Unknown: /auto-continue ${args.join(" ")}\nType /auto-continue help for available commands.`,
    );
    throw new Error("__AUTO_CONTINUE_HANDLED__");
  }

  return {
    // Register /auto-continue and /ac commands
    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["auto-continue"] = {
        template: "",
        description: "Manage auto-continue settings (on/off, throttle, delay, max, reload)",
      };
      opencodeConfig.command["ac"] = {
        template: "",
        description: "Manage auto-continue settings (on/off, throttle, delay, max, reload)",
      };
    },

    // Route both commands to the same handler
    "command.execute.before": async (input: any, _output: any) => {
      if (input.command !== "auto-continue" && input.command !== "ac") return;
      await handleCommand(input);
    },

    // React to events for auto-continue behavior
    event: async ({ event }) => {
      // ── session.error: detect retryable errors ──
      if (event.type === "session.error") {
        const props = event.properties as {
          sessionID?: string;
          error?: unknown;
        };
        const { sessionID, error } = props;
        if (!sessionID) return;

        const config = getEffectiveConfig(sessionID);
        if (!config.enabled) return;

        if (isRetryableError(error, config)) {
          log(`Retryable error in ${sessionID}: ${errorMessage(error)}`);
          const state = getState(sessionID);
          state.lastErrorTime = Date.now();
          state.pendingContinue = true;
        }
      }

      // ── message.updated: detect errors + reset on success ──
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
        if (!info?.sessionID || info.role !== "assistant") return;

        const config = getEffectiveConfig(info.sessionID);

        // Retryable error on assistant message
        if (config.enabled && isRetryableError(info.error, config)) {
          log(`Retryable error on assistant message in ${info.sessionID}: ${errorMessage(info.error)}`);
          const state = getState(info.sessionID);
          state.lastErrorTime = Date.now();
          state.pendingContinue = true;
        }

        // Reset counter on successful completion
        if (info.metadata?.done && !info.error) {
          const state = sessions.get(info.sessionID);
          if (state && state.consecutiveCount > 0) {
            log(`${info.sessionID} completed successfully, resetting counter`);
            state.consecutiveCount = 0;
          }
        }
      }

      // ── session.idle: send continue if pending ──
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID?: string };
        const sessionID = props.sessionID;
        if (!sessionID) return;

        const config = getEffectiveConfig(sessionID);
        if (!config.enabled) return;

        const state = sessions.get(sessionID);
        if (state?.pendingContinue) {
          log(`${sessionID} idle with pending continue, waiting ${config.delayMs}ms...`);
          setTimeout(() => sendContinue(sessionID), config.delayMs);
        }
      }
    },
  };
};

export default plugin;
