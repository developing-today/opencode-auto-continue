const PLUGIN_NAME = "opencode-auto-continue";
/**
 * Configuration constants.
 * COOLDOWN_MS: minimum time between auto-continues for the same session (prevents infinite loops)
 * DELAY_MS: delay after session.idle before sending continue (lets things settle)
 * MAX_CONSECUTIVE: max consecutive auto-continues per session before giving up
 */
const COOLDOWN_MS = 5_000;
const DELAY_MS = 2_000;
const MAX_CONSECUTIVE = 5;
function isBadRequestError(error) {
    if (!error || typeof error !== "object")
        return false;
    const err = error;
    const data = err.data;
    // ApiError with statusCode 400
    if (err.name === "APIError" || err.name === "ApiError") {
        if (data?.statusCode === 400)
            return true;
        if (typeof data?.message === "string" && data.message.toLowerCase().includes("bad request"))
            return true;
    }
    // UnknownError with "bad request" in message
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
const plugin = async ({ client }) => {
    const sessions = new Map();
    function log(msg) {
        console.log(`[${PLUGIN_NAME}] ${msg}`);
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
        const now = Date.now();
        if (now - state.lastContinueTime < COOLDOWN_MS) {
            log(`Cooldown active for session ${sessionID}, skipping`);
            return;
        }
        if (state.consecutiveCount >= MAX_CONSECUTIVE) {
            log(`Max consecutive auto-continues (${MAX_CONSECUTIVE}) reached for session ${sessionID}, giving up`);
            state.pendingContinue = false;
            return;
        }
        state.lastContinueTime = now;
        state.consecutiveCount++;
        state.pendingContinue = false;
        log(`Sending "continue" to session ${sessionID} (attempt ${state.consecutiveCount}/${MAX_CONSECUTIVE})`);
        try {
            await client.session.promptAsync({
                path: { id: sessionID },
                body: {
                    parts: [{ type: "text", text: "continue" }],
                },
            });
            log(`Successfully sent "continue" to session ${sessionID}`);
        }
        catch (err) {
            log(`Failed to send "continue" to session ${sessionID}: ${err}`);
        }
    }
    return {
        event: async ({ event }) => {
            // ── session.error: detect bad request errors ──
            if (event.type === "session.error") {
                const props = event.properties;
                const { sessionID, error } = props;
                if (!sessionID)
                    return;
                if (isBadRequestError(error)) {
                    log(`Bad request error in session ${sessionID}: ${errorMessage(error)}`);
                    const state = getState(sessionID);
                    state.lastErrorTime = Date.now();
                    state.pendingContinue = true;
                }
            }
            // ── message.updated: detect bad request errors on assistant messages ──
            if (event.type === "message.updated") {
                const props = event.properties;
                const info = props.info;
                if (!info?.sessionID || info.role !== "assistant")
                    return;
                if (isBadRequestError(info.error)) {
                    log(`Bad request error on assistant message in session ${info.sessionID}: ${errorMessage(info.error)}`);
                    const state = getState(info.sessionID);
                    state.lastErrorTime = Date.now();
                    state.pendingContinue = true;
                }
            }
            // ── session.idle: send continue if pending ──
            if (event.type === "session.idle") {
                const props = event.properties;
                const sessionID = props.sessionID;
                if (!sessionID)
                    return;
                const state = sessions.get(sessionID);
                if (state?.pendingContinue) {
                    log(`Session ${sessionID} is idle with pending continue, waiting ${DELAY_MS}ms...`);
                    setTimeout(() => sendContinue(sessionID), DELAY_MS);
                }
            }
            // ── Reset consecutive counter on successful completion ──
            // When a message completes without error, reset the counter
            if (event.type === "message.updated") {
                const props = event.properties;
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
//# sourceMappingURL=index.js.map