import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { createTurnEvidence, isCompletedEmptyResponse, recordTextPart, updateAssistantEvidence, } from "./recovery.js";
const PLUGIN_NAME = "opencode-auto-continue";
const CONFIG_DIR = ".opencode";
const CONFIG_FILE = `${PLUGIN_NAME}.jsonc`;
// ─── Default retryable error patterns ───────────────────────────────────────
// Matched case-insensitively against "${errorType}: ${errorMessage}".
// Override via config file's "errorPatterns" array.
const DEFAULT_ERROR_PATTERNS = [
    // OpenCode v2 structured error types
    "provider.invalid-request",
    "provider.invalid-output",
    "provider.transport",
    "provider.timeout",
    "provider.internal",
    "provider.unknown",
    "tool.execution",
    // API / provider error messages
    "bad request",
    "reasoning_opaque",
    "prefill",
    "SSE read timed out",
    "DecimalError",
    // Context / compaction errors
    "ContextOverflowError",
    "too large to compact",
    // Tool execution errors
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
const DEFAULT_EXCLUDE_PATTERNS = [
    // User-initiated abort — never auto-continue
    "MessageAbortedError",
    "operation was aborted",
];
/**
 * Default configuration values.
 */
const DEFAULTS = {
    /** Minimum ms between auto-continues for the same session */
    throttleMs: 5_000,
    /** Delay after the session goes idle before sending continue */
    delayMs: 500,
    /** Max consecutive auto-continues per session before giving up (0 = unlimited) */
    maxConsecutive: 5,
    /** Whether the plugin is enabled */
    enabled: true,
    /** Retry completed assistant responses that contain no usable output */
    retryEmptyResponses: true,
    /** Abort and retry a busy request with no assistant activity after this delay (0 disables) */
    stalledRequestTimeoutMs: 200_000,
    /** Error patterns to auto-continue on (case-insensitive substrings) */
    errorPatterns: DEFAULT_ERROR_PATTERNS,
    /** Error patterns to NEVER auto-continue on (checked first, case-insensitive substrings) */
    excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
};
// ─── Helpers ────────────────────────────────────────────────────────────────
function parseJsonc(text) {
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
    // Strip trailing commas before } or ]
    result = result.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(result);
}
async function loadConfig(directory, log) {
    const configPath = join(directory, CONFIG_DIR, CONFIG_FILE);
    try {
        const raw = await readFile(configPath, "utf-8");
        const parsed = parseJsonc(raw);
        const config = { ...DEFAULTS };
        if (typeof parsed.throttleMs === "number")
            config.throttleMs = parsed.throttleMs;
        if (typeof parsed.delayMs === "number")
            config.delayMs = parsed.delayMs;
        if (typeof parsed.maxConsecutive === "number")
            config.maxConsecutive = parsed.maxConsecutive;
        if (typeof parsed.enabled === "boolean")
            config.enabled = parsed.enabled;
        if (typeof parsed.retryEmptyResponses === "boolean")
            config.retryEmptyResponses = parsed.retryEmptyResponses;
        if (typeof parsed.stalledRequestTimeoutMs === "number") {
            config.stalledRequestTimeoutMs = parsed.stalledRequestTimeoutMs;
        }
        if (Array.isArray(parsed.errorPatterns)) {
            config.errorPatterns = parsed.errorPatterns.filter((p) => typeof p === "string");
        }
        if (Array.isArray(parsed.excludePatterns)) {
            config.excludePatterns = parsed.excludePatterns.filter((p) => typeof p === "string");
        }
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
/**
 * Extract the error type/name and message from an OpenCode v2 structured error
 * (`{ type, message, status?, response? }`) while tolerating legacy
 * `{ name, message, data: { message } }` shapes.
 */
function errorParts(error) {
    if (!error || typeof error !== "object")
        return { type: "", message: "" };
    const err = error;
    const data = err.data;
    const type = typeof err.type === "string" ? err.type : typeof err.name === "string" ? err.name : "";
    const message = (typeof data?.message === "string" ? data.message : null) ??
        (typeof err.message === "string" ? err.message : "");
    return { type, message };
}
function isRetryableError(error, config) {
    if (!error || typeof error !== "object")
        return false;
    const { type, message } = errorParts(error);
    // Build a single matchable string: "ErrorType: error message text"
    const matchStr = `${type}: ${message}`.toLowerCase();
    // Exclude patterns checked first — if any match, never retry
    for (const pattern of config.excludePatterns) {
        if (matchStr.includes(pattern.toLowerCase()))
            return false;
    }
    // Error patterns — if any match, retry
    for (const pattern of config.errorPatterns) {
        if (matchStr.includes(pattern.toLowerCase()))
            return true;
    }
    return false;
}
function isExcludedError(error, config) {
    if (!error || typeof error !== "object")
        return false;
    const { type, message } = errorParts(error);
    const matchStr = `${type}: ${message}`.toLowerCase();
    return config.excludePatterns.some((pattern) => matchStr.includes(pattern.toLowerCase()));
}
function errorMessage(error) {
    if (!error || typeof error !== "object")
        return "unknown";
    const err = error;
    const data = err.data;
    return ((typeof data?.message === "string" ? data.message : null) ??
        (typeof err.message === "string" ? err.message : null) ??
        String(err.type ?? err.name ?? "unknown"));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ─── Plugin ─────────────────────────────────────────────────────────────────
const plugin = Plugin.define({
    id: PLUGIN_NAME,
    async setup(ctx) {
        const directory = ctx.location.directory;
        const sessions = new Map();
        const sessionConfigs = new Map();
        // Inbox IDs of the display-only synthetic messages this plugin sends, so
        // their delivery does not reset the turn state they report on.
        const ownInboxIDs = new Set();
        // Silent log — console.log leaks into the TUI as raw terminal output
        function log(_msg) {
            // intentionally silent
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
        // Write a message that appears in chat but does NOT trigger the LLM.
        // The inbox ID is generated up-front and registered before the call, so a
        // session.inbox.delivered event that beats the response cannot reset the
        // turn state the message reports on.
        async function sendMessage(sessionID, text) {
            const messageID = `msg_${crypto.randomUUID()}`;
            // Bound the tracking set: IDs are removed when their delivery is
            // observed, but missed deliveries must not accumulate forever.
            if (ownInboxIDs.size > 512) {
                const oldest = ownInboxIDs.values().next().value;
                if (oldest !== undefined)
                    ownInboxIDs.delete(oldest);
            }
            ownInboxIDs.add(messageID);
            try {
                const item = await ctx.session.synthetic({ sessionID, id: messageID, text, resume: false });
                if (item?.id && item.id !== messageID)
                    ownInboxIDs.add(item.id);
            }
            catch (err) {
                ownInboxIDs.delete(messageID);
                log(`Failed to send message to ${sessionID}: ${err}`);
            }
        }
        // Write current globalConfig to disk
        async function writeGlobalConfig() {
            const configPath = join(directory, CONFIG_DIR, CONFIG_FILE);
            await mkdir(join(directory, CONFIG_DIR), { recursive: true });
            // Omit pattern arrays from disk if they're still the defaults
            const toWrite = {
                throttleMs: globalConfig.throttleMs,
                delayMs: globalConfig.delayMs,
                maxConsecutive: globalConfig.maxConsecutive,
                enabled: globalConfig.enabled,
                retryEmptyResponses: globalConfig.retryEmptyResponses,
                stalledRequestTimeoutMs: globalConfig.stalledRequestTimeoutMs,
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
        function getState(sessionID) {
            let state = sessions.get(sessionID);
            if (!state) {
                state = {
                    lastErrorTime: 0,
                    lastContinueTime: 0,
                    pendingContinue: false,
                    consecutiveCount: 0,
                    turn: createTurnEvidence(),
                    busy: false,
                    pluginAbortPending: false,
                    sawAssistantActivity: false,
                };
                sessions.set(sessionID, state);
            }
            return state;
        }
        function clearIdleTimer(state) {
            if (state.idleTimer)
                clearTimeout(state.idleTimer);
            state.idleTimer = undefined;
        }
        function clearStalledTimer(state) {
            if (state.stalledTimer)
                clearTimeout(state.stalledTimer);
            state.stalledTimer = undefined;
        }
        function hasAssistantActivity(state) {
            const assistant = state.turn.assistant;
            return Boolean(state.sawAssistantActivity ||
                (assistant && (assistant.outputTokens > 0 || assistant.sawText || assistant.finish === "tool-calls")));
        }
        function markAssistantActivity(sessionID) {
            const state = getState(sessionID);
            state.sawAssistantActivity = true;
            clearStalledTimer(state);
        }
        function startStalledTimer(sessionID, state) {
            const config = getEffectiveConfig(sessionID);
            if (state.stalledTimer)
                return;
            if (!config.enabled || config.stalledRequestTimeoutMs <= 0 || hasAssistantActivity(state))
                return;
            if (state.pluginAbortPending)
                return;
            if (state.turn.waitingForQuestion || state.turn.waitingForPermission)
                return;
            state.stalledTimer = setTimeout(async () => {
                state.stalledTimer = undefined;
                const currentConfig = getEffectiveConfig(sessionID);
                if (!currentConfig.enabled || !state.busy || hasAssistantActivity(state))
                    return;
                if (state.turn.waitingForQuestion || state.turn.waitingForPermission)
                    return;
                if (currentConfig.maxConsecutive > 0 && state.consecutiveCount >= currentConfig.maxConsecutive)
                    return;
                state.pluginAbortPending = true;
                state.pendingContinue = true;
                try {
                    await ctx.session.interrupt({ sessionID, resume: false });
                }
                catch (err) {
                    state.pluginAbortPending = false;
                    state.pendingContinue = false;
                    log(`Failed to interrupt stalled request in ${sessionID}: ${err}`);
                }
            }, config.stalledRequestTimeoutMs);
        }
        function resetTurn(state) {
            clearIdleTimer(state);
            clearStalledTimer(state);
            state.pendingContinue = false;
            state.pluginAbortPending = false;
            state.sawAssistantActivity = false;
            state.turn = createTurnEvidence();
        }
        // Cancel any queued auto-continue (e.g. when the plugin is disabled for a
        // session). Enabling again never resurrects the cancelled retry.
        function cancelPendingRetry(sessionID) {
            const state = sessions.get(sessionID);
            if (!state)
                return;
            state.pendingContinue = false;
            clearIdleTimer(state);
            clearStalledTimer(state);
        }
        function cancelAllPendingRetries() {
            for (const sessionID of sessions.keys())
                cancelPendingRetry(sessionID);
        }
        async function sendContinue(sessionID) {
            const state = sessions.get(sessionID);
            if (!state?.pendingContinue)
                return;
            const config = getEffectiveConfig(sessionID);
            // Re-validate at send time: the session may have been disabled or the
            // turn state changed while a delay/throttle timer was pending.
            if (!config.enabled ||
                state.busy ||
                state.turn.aborted ||
                state.turn.waitingForQuestion ||
                state.turn.waitingForPermission) {
                state.pendingContinue = false;
                clearIdleTimer(state);
                return;
            }
            const now = Date.now();
            if (now - state.lastContinueTime < config.throttleMs) {
                const remaining = config.throttleMs - (now - state.lastContinueTime);
                log(`Throttle active for session ${sessionID}, retrying in ${remaining}ms`);
                clearIdleTimer(state);
                state.idleTimer = setTimeout(() => {
                    state.idleTimer = undefined;
                    void sendContinue(sessionID);
                }, remaining);
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
                // A plain prompt keeps the session's currently selected agent and model;
                // the `agents` prompt field is only for explicit @-mentions.
                await ctx.session.prompt({ sessionID, text: "continue" });
                log(`Successfully sent "continue" to ${sessionID}`);
            }
            catch (err) {
                log(`Failed to send "continue" to ${sessionID}: ${err}`);
            }
        }
        function handleSessionIdle(sessionID) {
            const config = getEffectiveConfig(sessionID);
            if (!config.enabled)
                return;
            const state = sessions.get(sessionID);
            if (!state || state.idleTimer)
                return;
            state.busy = false;
            clearStalledTimer(state);
            if (state.pluginAbortPending) {
                state.turn.aborted = false;
            }
            if (state.turn.aborted || state.turn.waitingForQuestion || state.turn.waitingForPermission)
                return;
            if (!state.pendingContinue && !(config.retryEmptyResponses && isCompletedEmptyResponse(state.turn)))
                return;
            log(`${sessionID} idle with pending continue, waiting ${config.delayMs}ms...`);
            state.idleTimer = setTimeout(() => {
                state.idleTimer = undefined;
                if (!state.pendingContinue && !(config.retryEmptyResponses && isCompletedEmptyResponse(state.turn)))
                    return;
                state.pendingContinue = true;
                void sendContinue(sessionID);
            }, config.delayMs);
        }
        function isForeignLocation(event) {
            const location = event.location;
            if (!location || typeof location.directory !== "string")
                return false;
            if (location.directory !== ctx.location.directory)
                return true;
            const ownWorkspace = ctx.location.workspaceID;
            if (ownWorkspace !== undefined &&
                location.workspaceID !== undefined &&
                location.workspaceID !== ownWorkspace) {
                return true;
            }
            return false;
        }
        async function handleEvent(event) {
            switch (event.type) {
                // A new input was admitted into session history (user prompt, steering
                // message, or synthetic input). Starts a fresh turn.
                case "session.inbox.delivered": {
                    const { sessionID, inboxID } = event.data;
                    if (ownInboxIDs.delete(inboxID))
                        return; // our own display-only output
                    const state = getState(sessionID);
                    if (state.userMessageID === inboxID)
                        return;
                    state.userMessageID = inboxID;
                    resetTurn(state);
                    return;
                }
                // Session status: busy while a turn is executing, retry while OpenCode
                // schedules an internal retry, idle once the turn settles.
                case "session.status": {
                    const { sessionID, status } = event.data;
                    const state = getState(sessionID);
                    if (status.type === "busy") {
                        state.busy = true;
                        startStalledTimer(sessionID, state);
                    }
                    else if (status.type === "idle") {
                        handleSessionIdle(sessionID);
                    }
                    else {
                        // "retry" — OpenCode is retrying the provider call itself.
                        state.busy = false;
                        clearStalledTimer(state);
                    }
                    return;
                }
                case "session.idle": {
                    handleSessionIdle(event.data.sessionID);
                    return;
                }
                case "session.execution.started": {
                    const { sessionID } = event.data;
                    const state = getState(sessionID);
                    state.busy = true;
                    startStalledTimer(sessionID, state);
                    return;
                }
                // The turn finished without a fatal error. No counter reset here: an
                // empty response also "succeeds", and the counter must keep limiting.
                case "session.execution.succeeded": {
                    handleSessionIdle(event.data.sessionID);
                    return;
                }
                // The turn failed with a terminal error.
                case "session.execution.failed": {
                    const { sessionID, error } = event.data;
                    const config = getEffectiveConfig(sessionID);
                    if (!config.enabled)
                        return;
                    const state = getState(sessionID);
                    state.busy = false;
                    if (state.pluginAbortPending) {
                        // Our own watchdog interrupt ended the turn — retry after idle.
                        handleSessionIdle(sessionID);
                        return;
                    }
                    if (isExcludedError(error, config)) {
                        state.turn.aborted = true;
                        state.pendingContinue = false;
                        clearIdleTimer(state);
                        clearStalledTimer(state);
                        return;
                    }
                    if (isRetryableError(error, config)) {
                        log(`Retryable error in ${sessionID}: ${errorMessage(error)}`);
                        state.lastErrorTime = Date.now();
                        state.pendingContinue = true;
                    }
                    // The turn is over; recover even if no idle/status event follows.
                    handleSessionIdle(sessionID);
                    return;
                }
                // The turn was interrupted. Either our stall watchdog did it (retry
                // after idle) or the user/system did (never auto-continue).
                case "session.execution.interrupted": {
                    const { sessionID } = event.data;
                    const state = getState(sessionID);
                    state.busy = false;
                    if (state.pluginAbortPending) {
                        state.turn.aborted = false;
                        handleSessionIdle(sessionID);
                        return;
                    }
                    state.turn.aborted = true;
                    state.pendingContinue = false;
                    clearIdleTimer(state);
                    clearStalledTimer(state);
                    return;
                }
                // A model step begins. Any earlier failure is being handled by
                // OpenCode itself (internal retry or tool loop) — stand down.
                case "session.step.started": {
                    const { sessionID, assistantMessageID } = event.data;
                    const state = getState(sessionID);
                    state.pendingContinue = false;
                    clearIdleTimer(state);
                    updateAssistantEvidence(state.turn, { id: assistantMessageID });
                    return;
                }
                case "session.step.streamed": {
                    markAssistantActivity(event.data.sessionID);
                    return;
                }
                case "session.step.ended": {
                    const { sessionID, assistantMessageID, finish, tokens } = event.data;
                    const state = getState(sessionID);
                    const config = getEffectiveConfig(sessionID);
                    updateAssistantEvidence(state.turn, { id: assistantMessageID, finish, tokens });
                    if (hasAssistantActivity(state)) {
                        state.sawAssistantActivity = true;
                        clearStalledTimer(state);
                    }
                    // Successful completion → clear pending retries and reset the counter
                    if (finish === "stop") {
                        clearIdleTimer(state);
                        clearStalledTimer(state);
                        state.pendingContinue = false;
                        if (state.consecutiveCount > 0) {
                            log(`${sessionID} completed successfully, resetting counter`);
                            state.consecutiveCount = 0;
                        }
                    }
                    // A completed-but-empty response may never see session.idle — reuse
                    // the same guarded recovery path so status and auto-continue agree.
                    if (finish === "unknown" &&
                        config.retryEmptyResponses &&
                        isCompletedEmptyResponse(state.turn)) {
                        handleSessionIdle(sessionID);
                    }
                    return;
                }
                case "session.step.failed": {
                    const { sessionID, assistantMessageID, error, tokens } = event.data;
                    const config = getEffectiveConfig(sessionID);
                    if (!config.enabled)
                        return;
                    const state = getState(sessionID);
                    updateAssistantEvidence(state.turn, { id: assistantMessageID, error, tokens });
                    if (state.pluginAbortPending)
                        return;
                    if (isExcludedError(error, config)) {
                        state.turn.aborted = true;
                        state.pendingContinue = false;
                        clearIdleTimer(state);
                        clearStalledTimer(state);
                        return;
                    }
                    if (isRetryableError(error, config)) {
                        log(`Retryable error on assistant step in ${sessionID}: ${errorMessage(error)}`);
                        state.lastErrorTime = Date.now();
                        state.pendingContinue = true;
                    }
                    return;
                }
                // OpenCode scheduled its own retry — do not double-retry.
                case "session.retry.scheduled": {
                    const state = getState(event.data.sessionID);
                    state.pendingContinue = false;
                    clearIdleTimer(state);
                    clearStalledTimer(state);
                    return;
                }
                case "session.text.delta":
                case "session.reasoning.delta": {
                    if (!event.data.delta.trim())
                        return;
                    markAssistantActivity(event.data.sessionID);
                    return;
                }
                case "session.text.ended": {
                    const { sessionID, assistantMessageID, text } = event.data;
                    const state = getState(sessionID);
                    recordTextPart(state.turn, { messageID: assistantMessageID, type: "text", text });
                    if (text.trim())
                        markAssistantActivity(sessionID);
                    return;
                }
                case "session.reasoning.ended": {
                    if (!event.data.text.trim())
                        return;
                    markAssistantActivity(event.data.sessionID);
                    return;
                }
                case "session.tool.called":
                case "session.tool.input.started":
                case "session.tool.input.delta":
                case "session.tool.progress":
                case "session.tool.success":
                case "session.tool.failed": {
                    markAssistantActivity(event.data.sessionID);
                    return;
                }
                // Permission prompts pause the turn and wait for the user.
                case "permission.asked": {
                    const state = getState(event.data.sessionID);
                    state.turn.waitingForPermission = true;
                    state.pendingContinue = false;
                    clearIdleTimer(state);
                    clearStalledTimer(state);
                    return;
                }
                case "permission.replied": {
                    getState(event.data.sessionID).turn.waitingForPermission = false;
                    return;
                }
                // The question tool renders through forms; any pending form means the
                // session is waiting for user input.
                case "form.created": {
                    const sessionID = event.data.form.sessionID;
                    if (!sessionID)
                        return;
                    const state = getState(sessionID);
                    state.turn.waitingForQuestion = true;
                    state.pendingContinue = false;
                    clearIdleTimer(state);
                    clearStalledTimer(state);
                    return;
                }
                case "form.replied":
                case "form.cancelled": {
                    const sessionID = event.data.sessionID;
                    if (!sessionID)
                        return;
                    getState(sessionID).turn.waitingForQuestion = false;
                    return;
                }
                case "session.deleted": {
                    const state = sessions.get(event.data.sessionID);
                    if (state) {
                        clearIdleTimer(state);
                        clearStalledTimer(state);
                    }
                    sessions.delete(event.data.sessionID);
                    sessionConfigs.delete(event.data.sessionID);
                    return;
                }
            }
        }
        // ── Command UI helpers ──────────────────────────────────────────────────
        function overrideLines(overrides) {
            const parts = [];
            if (overrides.enabled !== undefined)
                parts.push(`enabled: ${overrides.enabled}`);
            if (overrides.throttleMs !== undefined)
                parts.push(`throttle: ${overrides.throttleMs}ms`);
            if (overrides.delayMs !== undefined)
                parts.push(`delay: ${overrides.delayMs}ms`);
            if (overrides.maxConsecutive !== undefined)
                parts.push(`max: ${overrides.maxConsecutive === 0 ? "unlimited" : overrides.maxConsecutive}`);
            const globalParts = [
                `enabled: ${globalConfig.enabled}`,
                `throttle: ${globalConfig.throttleMs}ms`,
                `delay: ${globalConfig.delayMs}ms`,
                `max: ${globalConfig.maxConsecutive === 0 ? "unlimited" : globalConfig.maxConsecutive}`,
            ];
            return ["", `  Session overrides: ${parts.join(" · ")}`, `  Global defaults:   ${globalParts.join(" · ")}`];
        }
        async function configSummaryLines(sessionID) {
            const cfg = getEffectiveConfig(sessionID);
            const overrides = sessionConfigs.get(sessionID);
            const status = cfg.enabled ? "✅ enabled" : "❌ disabled";
            const maxDisplay = cfg.maxConsecutive === 0 ? "unlimited" : String(cfg.maxConsecutive);
            const summaryParts = [`Throttle: ${cfg.throttleMs}ms`, `Delay: ${cfg.delayMs}ms`, `Max: ${maxDisplay}`];
            const lines = [`  Status: ${status}`, `  ${summaryParts.join(" · ")}`];
            if (overrides && Object.keys(overrides).length > 0) {
                lines.push(...overrideLines(overrides));
            }
            return lines;
        }
        async function helpText(sessionID) {
            const lines = [
                "╭──────────────────────────────────────────╮",
                "│       Auto-Continue Commands             │",
                "╰──────────────────────────────────────────╯",
                "",
                ...(await configSummaryLines(sessionID)),
            ];
            lines.push("", "  /auto-continue on|off              Enable/disable (session)", "  /auto-continue throttle <ms>       Set retry throttle (session)", "  /auto-continue delay <ms>          Set delay (session)", "  /auto-continue max <n>             Set max retries (session, 0=unlimited)", "  /auto-continue status              Show current settings", "  /auto-continue patterns            Show active error patterns", "  /auto-continue reload              Reload global config from disk", "  /auto-continue reset               Clear session overrides", "  /auto-continue global <cmd>        Persist setting to config file", "  /auto-continue help                Show this help", "", "  Alias: /ac (same commands, e.g. /ac status)");
            return lines.join("\n");
        }
        async function statusText(sessionID) {
            const cfg = getEffectiveConfig(sessionID);
            const overrides = sessionConfigs.get(sessionID);
            const state = sessions.get(sessionID);
            const lines = [
                "╭──────────────────────────────────────────╮",
                "│       Auto-Continue Status               │",
                "╰──────────────────────────────────────────╯",
                "",
                `  Enabled:         ${cfg.enabled ? "✅ yes" : "❌ no"}`,
                `  Throttle:        ${cfg.throttleMs}ms`,
                `  Delay:           ${cfg.delayMs}ms`,
                `  Max Retries:     ${cfg.maxConsecutive === 0 ? "unlimited (0)" : cfg.maxConsecutive}`,
                `  Stall timeout:   ${cfg.stalledRequestTimeoutMs > 0 ? `${cfg.stalledRequestTimeoutMs}ms` : "disabled"}`,
            ];
            if (overrides && Object.keys(overrides).length > 0) {
                lines.push("");
                lines.push("  ── Session Overrides ──");
                if (overrides.enabled !== undefined)
                    lines.push(`  Enabled:         ${overrides.enabled ? "✅ yes" : "❌ no"}  (global: ${globalConfig.enabled ? "yes" : "no"})`);
                if (overrides.throttleMs !== undefined)
                    lines.push(`  Throttle:        ${overrides.throttleMs}ms  (global: ${globalConfig.throttleMs}ms)`);
                if (overrides.delayMs !== undefined)
                    lines.push(`  Delay:           ${overrides.delayMs}ms  (global: ${globalConfig.delayMs}ms)`);
                if (overrides.maxConsecutive !== undefined)
                    lines.push(`  Max Retries:     ${overrides.maxConsecutive === 0 ? "unlimited (0)" : overrides.maxConsecutive}  (global: ${globalConfig.maxConsecutive === 0 ? "unlimited (0)" : globalConfig.maxConsecutive})`);
            }
            const retryRemaining = state?.lastContinueTime && state.lastContinueTime > 0
                ? Math.max(0, cfg.throttleMs - (Date.now() - state.lastContinueTime))
                : null;
            lines.push("", "  ── Session State ──");
            if (retryRemaining !== null) {
                lines.push(`  Retry cooldown:      ${retryRemaining > 0 ? `${retryRemaining}ms` : "ready"}`);
            }
            lines.push(`  Consecutive retries: ${state?.consecutiveCount ?? 0}`, `  Pending continue:    ${state?.pendingContinue ? "yes" : "no"}`, "", "  ── Global Config ──", `  ${JSON.stringify({ ...globalConfig, errorPatterns: `[${globalConfig.errorPatterns.length} patterns]`, excludePatterns: `[${globalConfig.excludePatterns.length} patterns]` })}`);
            const isCustomPatterns = globalConfig.errorPatterns !== DEFAULT_ERROR_PATTERNS;
            const isCustomExcludes = globalConfig.excludePatterns !== DEFAULT_EXCLUDE_PATTERNS;
            lines.push("", `  ── Error Patterns (${cfg.errorPatterns.length} match, ${cfg.excludePatterns.length} exclude) ──`, `  Patterns: ${isCustomPatterns ? "custom" : "default"}  ·  Excludes: ${isCustomExcludes ? "custom" : "default"}`, "  Run /ac patterns for full list");
            return lines.join("\n");
        }
        // ── Command handler shared by /auto-continue and /ac ────────────────────
        async function handleCommand(sessionID, argsText) {
            const args = argsText.trim().split(/\s+/).filter(Boolean);
            const subcmd = args[0]?.toLowerCase() || "";
            // ── Help (default) ──
            if (!subcmd || subcmd === "help") {
                await sendMessage(sessionID, await helpText(sessionID));
                return;
            }
            // ── On / Off ──
            if (subcmd === "on" || subcmd === "off") {
                const enabled = subcmd === "on";
                const overrides = sessionConfigs.get(sessionID) || {};
                overrides.enabled = enabled;
                sessionConfigs.set(sessionID, overrides);
                if (!enabled)
                    cancelPendingRetry(sessionID);
                await sendMessage(sessionID, `Auto-continue ${enabled ? "✅ enabled" : "❌ disabled"} for this session.`);
                return;
            }
            // ── Throttle / Delay / Max ──
            if (subcmd === "throttle" || subcmd === "delay" || subcmd === "max") {
                const value = parseInt(args[1], 10);
                if (isNaN(value) || value < 0) {
                    await sendMessage(sessionID, `❌ Invalid value. Usage: /auto-continue ${subcmd} <number>`);
                    return;
                }
                const overrides = sessionConfigs.get(sessionID) || {};
                const keyMap = {
                    throttle: "throttleMs",
                    delay: "delayMs",
                    max: "maxConsecutive",
                };
                overrides[keyMap[subcmd]] = value;
                sessionConfigs.set(sessionID, overrides);
                const label = subcmd === "throttle"
                    ? "Throttle"
                    : subcmd === "delay"
                        ? "Delay"
                        : "Max consecutive";
                const unit = subcmd === "max" ? "" : "ms";
                await sendMessage(sessionID, `${label} set to ${value}${unit} for this session.`);
                return;
            }
            // ── Status ──
            if (subcmd === "status") {
                await sendMessage(sessionID, await statusText(sessionID));
                return;
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
                    "  Matching: case-insensitive substring against \"ErrorType: message\"",
                    "  Excludes are checked first. Override via config file.",
                ];
                await sendMessage(sessionID, lines.join("\n"));
                return;
            }
            // ── Reload (re-read global config from disk) ──
            if (subcmd === "reload") {
                const configPath = join(directory, CONFIG_DIR, CONFIG_FILE);
                let fileExists = false;
                let rawContents = "";
                try {
                    rawContents = await readFile(configPath, "utf-8");
                    fileExists = true;
                }
                catch {
                    // File doesn't exist
                }
                const reloaded = await loadConfig(directory, log);
                Object.assign(globalConfig, reloaded);
                if (!globalConfig.enabled)
                    cancelAllPendingRetries();
                const lines = [];
                if (fileExists) {
                    lines.push("Auto-continue global config reloaded", `  From: ${configPath}`, `  Contents: ${rawContents.trim()}`);
                }
                else {
                    lines.push("Auto-continue global config reloaded", `  No ${CONFIG_FILE} found at ${configPath} — using defaults`);
                }
                lines.push("", ...(await configSummaryLines(sessionID)));
                await sendMessage(sessionID, lines.join("\n"));
                return;
            }
            // ── Reset (clear session overrides) ──
            if (subcmd === "reset") {
                sessionConfigs.delete(sessionID);
                await sendMessage(sessionID, "Session overrides cleared. Using global config.");
                return;
            }
            // ── Global ──
            if (subcmd === "global") {
                const globalSub = args[1]?.toLowerCase() || "";
                if (globalSub === "on" || globalSub === "off") {
                    globalConfig.enabled = globalSub === "on";
                    await writeGlobalConfig();
                    if (!globalConfig.enabled)
                        cancelAllPendingRetries();
                    await sendMessage(sessionID, `Global config: auto-continue ${globalSub === "on" ? "✅ enabled" : "❌ disabled"}. Written to ${CONFIG_FILE}.`);
                    return;
                }
                if (globalSub === "throttle" || globalSub === "delay" || globalSub === "max") {
                    const value = parseInt(args[2], 10);
                    if (isNaN(value) || value < 0) {
                        await sendMessage(sessionID, `❌ Invalid value. Usage: /auto-continue global ${globalSub} <number>`);
                        return;
                    }
                    const keyMap = {
                        throttle: "throttleMs",
                        delay: "delayMs",
                        max: "maxConsecutive",
                    };
                    globalConfig[keyMap[globalSub]] = value;
                    await writeGlobalConfig();
                    const label = globalSub === "throttle"
                        ? "Throttle"
                        : globalSub === "delay"
                            ? "Delay"
                            : "Max consecutive";
                    const unit = globalSub === "max" ? "" : "ms";
                    await sendMessage(sessionID, `Global config: ${label} set to ${value}${unit}. Written to ${CONFIG_FILE}.`);
                    return;
                }
                // Global help (no recognized subcommand)
                const text = [
                    "Usage: /auto-continue global <subcommand>",
                    "",
                    "  on|off              Enable/disable globally",
                    "  throttle <ms>       Set global retry throttle",
                    "  delay <ms>          Set global delay",
                    "  max <n>             Set global max retries (0=unlimited)",
                    "",
                    "  Plugin updates are managed by OpenCode v2 via the `plugins`",
                    "  array in opencode.json(c) — update the package spec and restart.",
                ].join("\n");
                await sendMessage(sessionID, text);
                return;
            }
            // ── Unknown ──
            await sendMessage(sessionID, `❌ Unknown: /auto-continue ${args.join(" ")}\nType /auto-continue help for available commands.`);
        }
        // ── Registrations ───────────────────────────────────────────────────────
        // Register /auto-continue and /ac commands. The executor only renders
        // output through synthetic messages (resume: false) — it never submits a
        // prompt, so running a command never triggers a model call.
        await ctx.command.transform((editor) => {
            const description = "Manage auto-continue settings (on/off, throttle, delay, max, reload)";
            const execute = async ({ sessionID, prompt }) => {
                await handleCommand(sessionID, prompt.text);
            };
            editor.add({ name: "auto-continue", description, execute });
            editor.add({ name: "ac", description, execute });
        });
        // The question tool blocks the turn on user input — never auto-continue
        // across it.
        await ctx.tool.hook("execute.before", (event) => {
            if (event.tool !== "question" || !event.sessionID)
                return;
            const state = getState(event.sessionID);
            state.turn.waitingForQuestion = true;
            state.pendingContinue = false;
            clearIdleTimer(state);
            clearStalledTimer(state);
        });
        await ctx.tool.hook("execute.after", (event) => {
            if (event.tool !== "question" || !event.sessionID)
                return;
            getState(event.sessionID).turn.waitingForQuestion = false;
        });
        // Subscribe to the server event stream. State is keyed by sessionID; each
        // plugin instance only acts on events attributed to its own location.
        const controller = new AbortController();
        void (async () => {
            while (!controller.signal.aborted) {
                try {
                    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                        if (isForeignLocation(event))
                            continue;
                        try {
                            await handleEvent(event);
                        }
                        catch (err) {
                            log(`Error handling ${event.type} event: ${err}`);
                        }
                    }
                    if (controller.signal.aborted)
                        return;
                    log("Event stream ended — resubscribing");
                    await sleep(1_000);
                }
                catch (err) {
                    if (controller.signal.aborted)
                        return;
                    log(`Event stream error: ${err} — resubscribing`);
                    await sleep(1_000);
                }
            }
        })();
        return () => {
            controller.abort();
            for (const state of sessions.values()) {
                clearIdleTimer(state);
                clearStalledTimer(state);
            }
            sessions.clear();
        };
    },
});
export default plugin;
//# sourceMappingURL=index.js.map