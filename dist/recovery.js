export function createTurnEvidence() {
    return {
        aborted: false,
        waitingForQuestion: false,
        waitingForPermission: false,
    };
}
export function updateAssistantEvidence(turn, info) {
    if (!info.id)
        return;
    if (turn.assistant?.id !== info.id) {
        turn.assistant = {
            id: info.id,
            finish: info.finish,
            outputTokens: Number(info.tokens?.output) || 0,
            sawText: false,
            error: Boolean(info.error),
        };
        return;
    }
    turn.assistant.finish = info.finish ?? turn.assistant.finish;
    turn.assistant.outputTokens = Math.max(turn.assistant.outputTokens, Number(info.tokens?.output) || 0);
    turn.assistant.error ||= Boolean(info.error);
}
export function recordTextPart(turn, part) {
    if (turn.assistant &&
        part.messageID === turn.assistant.id &&
        part.type === "text" &&
        Boolean(part.text?.trim())) {
        turn.assistant.sawText = true;
    }
}
export function isCompletedEmptyResponse(turn) {
    const assistant = turn.assistant;
    return Boolean(assistant &&
        assistant.finish === "unknown" &&
        assistant.outputTokens === 0 &&
        !assistant.error &&
        !turn.aborted &&
        !turn.waitingForQuestion &&
        !turn.waitingForPermission);
}
//# sourceMappingURL=recovery.js.map