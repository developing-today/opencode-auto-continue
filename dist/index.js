import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const PLUGIN_NAME = "opencode-auto-continue";
const CONFIG_FILE = `${PLUGIN_NAME}.jsonc`;
const GITHUB_REPO = "developing-today/opencode-auto-continue";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
/**
 * Default configuration values.
 */
const DEFAULTS = {
    /** Minimum ms between auto-continues for the same session */
    cooldownMs: 5_000,
    /** Delay after session.idle before sending continue */
    delayMs: 2_000,
    /** Max consecutive auto-continues per session before giving up */
    maxConsecutive: 5,
    /** Whether the plugin is enabled */
    enabled: true,
};
// ─── Helpers ────────────────────────────────────────────────────────────────
function stripJsoncComments(text) {
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
        }
        else {
            if (text[i] === '"' || text[i] === "'") {
                inString = true;
                stringChar = text[i];
                result += text[i];
                i++;
            }
            else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "/") {
                while (i < text.length && text[i] !== "\n")
                    i++;
            }
            else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "*") {
                i += 2;
                while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/"))
                    i++;
                i += 2;
            }
            else {
                result += text[i];
                i++;
            }
        }
    }
    return result;
}
async function loadConfig(directory, log) {
    const configPath = join(directory, CONFIG_FILE);
    try {
        const raw = await readFile(configPath, "utf-8");
        const parsed = JSON.parse(stripJsoncComments(raw));
        const config = { ...DEFAULTS };
        if (typeof parsed.cooldownMs === "number")
            config.cooldownMs = parsed.cooldownMs;
        if (typeof parsed.delayMs === "number")
            config.delayMs = parsed.delayMs;
        if (typeof parsed.maxConsecutive === "number")
            config.maxConsecutive = parsed.maxConsecutive;
        if (typeof parsed.enabled === "boolean")
            config.enabled = parsed.enabled;
        log(`Loaded config from ${configPath}: ${JSON.stringify(config)}`);
        return config;
    }
    catch (err) {
        const code = err?.code;
        if (code === "ENOENT") {
            log(`No config file at ${configPath}, using defaults`);
        }
        else {
            log(`Error reading config from ${configPath}: ${err} — using defaults`);
        }
        return { ...DEFAULTS };
    }
}
function isBadRequestError(error) {
    if (!error || typeof error !== "object")
        return false;
    const err = error;
    const data = err.data;
    if (err.name === "APIError" || err.name === "ApiError") {
        if (data?.statusCode === 400)
            return true;
        if (typeof data?.message === "string" && data.message.toLowerCase().includes("bad request"))
            return true;
    }
    if (err.name === "UnknownError") {
        if (typeof data?.message === "string" && data.message.toLowerCase().includes("bad request"))
            return true;
    }
    return false;
}
function errorMessage(error) {
    if (!error || typeof error !== "object")
        return "unknown";
    const err = error;
    const data = err.data;
    return ((typeof data?.message === "string" ? data.message : null) ??
        (typeof err.message === "string" ? err.message : null) ??
        String(err.name ?? "unknown"));
}
// ─── Plugin ─────────────────────────────────────────────────────────────────
const plugin = async ({ client, directory }) => {
    const sessions = new Map();
    const sessionConfigs = new Map();
    function log(msg) {
        console.log(`[${PLUGIN_NAME}] ${msg}`);
    }
    // Global config — loaded from file, mutated by /auto-continue global commands
    const globalConfig = await loadConfig(directory, log);
    // Merge global config with per-session overrides
    function getEffectiveConfig(sessionID) {
        if (!sessionID)
            return globalConfig;
        const overrides = sessionConfigs.get(sessionID);
        if (!overrides)
            return globalConfig;
        return { ...globalConfig, ...overrides };
    }
    // Send a message that appears in chat but does NOT trigger the LLM
    async function sendMessage(sessionID, text) {
        await client.session.prompt({
            path: { id: sessionID },
            body: {
                noReply: true,
                parts: [{ type: "text", text, ignored: true }],
            },
        });
    }
    // Write current globalConfig to disk
    async function writeGlobalConfig() {
        const configPath = join(directory, CONFIG_FILE);
        const content = JSON.stringify(globalConfig, null, 2) + "\n";
        await writeFile(configPath, content, "utf-8");
        log(`Wrote global config to ${configPath}`);
    }
    function getState(sessionID) {
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
    async function sendContinue(sessionID) {
        const state = sessions.get(sessionID);
        if (!state?.pendingContinue)
            return;
        const config = getEffectiveConfig(sessionID);
        const now = Date.now();
        if (now - state.lastContinueTime < config.cooldownMs) {
            log(`Cooldown active for session ${sessionID}, skipping`);
            return;
        }
        if (state.consecutiveCount >= config.maxConsecutive) {
            log(`Max consecutive (${config.maxConsecutive}) reached for ${sessionID}, giving up`);
            state.pendingContinue = false;
            return;
        }
        state.lastContinueTime = now;
        state.consecutiveCount++;
        state.pendingContinue = false;
        log(`Sending "continue" to ${sessionID} (attempt ${state.consecutiveCount}/${config.maxConsecutive})`);
        try {
            await client.session.promptAsync({
                path: { id: sessionID },
                body: {
                    parts: [{ type: "text", text: "continue" }],
                },
            });
            log(`Successfully sent "continue" to ${sessionID}`);
        }
        catch (err) {
            log(`Failed to send "continue" to ${sessionID}: ${err}`);
        }
    }
    // ── Command UI helpers ──────────────────────────────────────────────────
    function helpText(sessionID) {
        const cfg = getEffectiveConfig(sessionID);
        const status = cfg.enabled ? "✅ enabled" : "❌ disabled";
        return [
            "╭──────────────────────────────────────────╮",
            "│       Auto-Continue Commands             │",
            "╰──────────────────────────────────────────╯",
            "",
            `  Status: ${status}`,
            `  Cooldown: ${cfg.cooldownMs}ms · Delay: ${cfg.delayMs}ms · Max: ${cfg.maxConsecutive}`,
            "",
            "  /auto-continue on|off          Enable/disable (session)",
            "  /auto-continue cooldown <ms>   Set cooldown (session)",
            "  /auto-continue delay <ms>      Set delay (session)",
            "  /auto-continue max <n>         Set max retries (session)",
            "  /auto-continue status          Show current settings",
            "  /auto-continue reset           Clear session overrides",
            "  /auto-continue reload           Reload global config from disk",
            "  /auto-continue global <cmd>    Persist setting to config file",
            "  /auto-continue global update   Clear cache to fetch latest version",
            "  /auto-continue help            Show this help",
            "",
            "  Alias: /ac (same commands, e.g. /ac status)",
        ].join("\n");
    }
    function statusText(sessionID) {
        const cfg = getEffectiveConfig(sessionID);
        const overrides = sessionConfigs.get(sessionID);
        const state = sessions.get(sessionID);
        return [
            "╭──────────────────────────────────────────╮",
            "│       Auto-Continue Status               │",
            "╰──────────────────────────────────────────╯",
            "",
            `  Enabled:      ${cfg.enabled ? "✅ yes" : "❌ no"}`,
            `  Cooldown:     ${cfg.cooldownMs}ms`,
            `  Delay:        ${cfg.delayMs}ms`,
            `  Max Retries:  ${cfg.maxConsecutive}`,
            "",
            "  ── Session ──",
            `  Consecutive retries: ${state?.consecutiveCount ?? 0}`,
            `  Pending continue:    ${state?.pendingContinue ? "yes" : "no"}`,
            overrides ? `  Overrides: ${JSON.stringify(overrides)}` : "  No session overrides",
            "",
            "  ── Global Config ──",
            `  ${JSON.stringify(globalConfig)}`,
        ].join("\n");
    }
    // ── Hooks ───────────────────────────────────────────────────────────────
    // Extracted command handler shared by /auto-continue and /ac
    async function handleCommand(input) {
        const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean);
        const subcmd = args[0]?.toLowerCase() || "";
        const sessionID = input.sessionID;
        // ── Help (default) ──
        if (!subcmd || subcmd === "help") {
            await sendMessage(sessionID, helpText(sessionID));
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
        // ── Cooldown / Delay / Max ──
        if (subcmd === "cooldown" || subcmd === "delay" || subcmd === "max") {
            const value = parseInt(args[1], 10);
            if (isNaN(value) || value < 0) {
                await sendMessage(sessionID, `❌ Invalid value. Usage: /auto-continue ${subcmd} <number>`);
                throw new Error("__AUTO_CONTINUE_HANDLED__");
            }
            const overrides = sessionConfigs.get(sessionID) || {};
            const keyMap = {
                cooldown: "cooldownMs",
                delay: "delayMs",
                max: "maxConsecutive",
            };
            overrides[keyMap[subcmd]] = value;
            sessionConfigs.set(sessionID, overrides);
            const label = subcmd === "cooldown" ? "Cooldown" : subcmd === "delay" ? "Delay" : "Max consecutive";
            const unit = subcmd === "max" ? "" : "ms";
            await sendMessage(sessionID, `${label} set to ${value}${unit} for this session.`);
            throw new Error("__AUTO_CONTINUE_HANDLED__");
        }
        // ── Status ──
        if (subcmd === "status") {
            await sendMessage(sessionID, statusText(sessionID));
            throw new Error("__AUTO_CONTINUE_HANDLED__");
        }
        // ── Reload (re-read global config from disk) ──
        if (subcmd === "reload") {
            const reloaded = await loadConfig(directory, log);
            Object.assign(globalConfig, reloaded);
            await sendMessage(sessionID, `Global config reloaded from disk.\n${JSON.stringify(globalConfig, null, 2)}`);
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
                    // 1. Fetch latest commit SHA from GitHub API
                    const response = await fetch(GITHUB_API_URL, {
                        headers: { "User-Agent": PLUGIN_NAME },
                    });
                    if (!response.ok) {
                        await sendMessage(sessionID, `❌ GitHub API returned ${response.status}: ${response.statusText}`);
                        throw new Error("__AUTO_CONTINUE_HANDLED__");
                    }
                    const data = (await response.json());
                    const latestSha = data.sha;
                    if (!latestSha || latestSha.length < 7) {
                        await sendMessage(sessionID, "❌ Failed to parse commit SHA from GitHub response.");
                        throw new Error("__AUTO_CONTINUE_HANDLED__");
                    }
                    const shortSha = latestSha.substring(0, 7);
                    // 2. Clear OpenCode's cached module and dependency entry so it re-installs on restart
                    const home = process.env.HOME || process.env.USERPROFILE || "";
                    const opencodeCacheDir = join(home, ".cache", "opencode");
                    let cacheCleared = false;
                    // Remove the cached node_modules entry
                    try {
                        const cachedMod = join(opencodeCacheDir, "node_modules", PLUGIN_NAME);
                        await rm(cachedMod, { recursive: true, force: true });
                        cacheCleared = true;
                    }
                    catch {
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
                    }
                    catch {
                        // Not critical
                    }
                    // Remove bun.lock to avoid stale resolution
                    try {
                        await rm(join(opencodeCacheDir, "bun.lock"), { force: true });
                    }
                    catch {
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
                    }
                    catch {
                        // Cache dir might not exist — not critical
                    }
                    const lines = [
                        `✅ Cache cleared. Latest commit on main: ${shortSha}`,
                        cacheCleared ? "   Removed cached module." : "   No cached module found.",
                        "   The 'latest' tag tarball will be re-fetched on next restart.",
                        "",
                        "   Restart OpenCode to load the new version.",
                    ];
                    await sendMessage(sessionID, lines.join("\n"));
                }
                catch (err) {
                    if (err instanceof Error && err.message === "__AUTO_CONTINUE_HANDLED__")
                        throw err;
                    await sendMessage(sessionID, `❌ Update failed: ${err}`);
                }
                throw new Error("__AUTO_CONTINUE_HANDLED__");
            }
            if (globalSub === "on" || globalSub === "off") {
                globalConfig.enabled = globalSub === "on";
                await writeGlobalConfig();
                await sendMessage(sessionID, `Global config: auto-continue ${globalSub === "on" ? "✅ enabled" : "❌ disabled"}. Written to ${CONFIG_FILE}.`);
                throw new Error("__AUTO_CONTINUE_HANDLED__");
            }
            if (globalSub === "cooldown" || globalSub === "delay" || globalSub === "max") {
                const value = parseInt(args[2], 10);
                if (isNaN(value) || value < 0) {
                    await sendMessage(sessionID, `❌ Invalid value. Usage: /auto-continue global ${globalSub} <number>`);
                    throw new Error("__AUTO_CONTINUE_HANDLED__");
                }
                const keyMap = {
                    cooldown: "cooldownMs",
                    delay: "delayMs",
                    max: "maxConsecutive",
                };
                globalConfig[keyMap[globalSub]] = value;
                await writeGlobalConfig();
                const label = globalSub === "cooldown" ? "Cooldown" : globalSub === "delay" ? "Delay" : "Max consecutive";
                const unit = globalSub === "max" ? "" : "ms";
                await sendMessage(sessionID, `Global config: ${label} set to ${value}${unit}. Written to ${CONFIG_FILE}.`);
                throw new Error("__AUTO_CONTINUE_HANDLED__");
            }
            // Global help (no recognized subcommand)
            const text = [
                "Usage: /auto-continue global <subcommand>",
                "",
                "  on|off          Enable/disable globally",
                "  cooldown <ms>   Set global cooldown",
                "  delay <ms>      Set global delay",
                "  max <n>         Set global max retries",
                "  update          Clear cache to fetch latest version",
            ].join("\n");
            await sendMessage(sessionID, text);
            throw new Error("__AUTO_CONTINUE_HANDLED__");
        }
        // ── Unknown ──
        await sendMessage(sessionID, `❌ Unknown: /auto-continue ${args.join(" ")}\nType /auto-continue help for available commands.`);
        throw new Error("__AUTO_CONTINUE_HANDLED__");
    }
    return {
        // Register /auto-continue and /ac commands
        config: async (opencodeConfig) => {
            opencodeConfig.command ??= {};
            opencodeConfig.command["auto-continue"] = {
                template: "",
                description: "Manage auto-continue settings (on/off, cooldown, delay, max, reload)",
            };
            opencodeConfig.command["ac"] = {
                template: "",
                description: "Alias for /auto-continue",
            };
        },
        // Route both commands to the same handler
        "command.execute.before": async (input, _output) => {
            if (input.command !== "auto-continue" && input.command !== "ac")
                return;
            await handleCommand(input);
        },
        // React to events for auto-continue behavior
        event: async ({ event }) => {
            // ── session.error: detect bad request errors ──
            if (event.type === "session.error") {
                const props = event.properties;
                const { sessionID, error } = props;
                if (!sessionID)
                    return;
                const config = getEffectiveConfig(sessionID);
                if (!config.enabled)
                    return;
                if (isBadRequestError(error)) {
                    log(`Bad request error in ${sessionID}: ${errorMessage(error)}`);
                    const state = getState(sessionID);
                    state.lastErrorTime = Date.now();
                    state.pendingContinue = true;
                }
            }
            // ── message.updated: detect errors + reset on success ──
            if (event.type === "message.updated") {
                const props = event.properties;
                const info = props.info;
                if (!info?.sessionID || info.role !== "assistant")
                    return;
                const config = getEffectiveConfig(info.sessionID);
                // Bad request on assistant message
                if (config.enabled && isBadRequestError(info.error)) {
                    log(`Bad request on assistant message in ${info.sessionID}: ${errorMessage(info.error)}`);
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
                const props = event.properties;
                const sessionID = props.sessionID;
                if (!sessionID)
                    return;
                const config = getEffectiveConfig(sessionID);
                if (!config.enabled)
                    return;
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
//# sourceMappingURL=index.js.map