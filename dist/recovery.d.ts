export interface AssistantEvidence {
    id: string;
    finish?: string;
    outputTokens: number;
    sawText: boolean;
    error: boolean;
}
export interface TurnEvidence {
    assistant?: AssistantEvidence;
    aborted: boolean;
    waitingForQuestion: boolean;
    waitingForPermission: boolean;
}
export declare function createTurnEvidence(): TurnEvidence;
export declare function updateAssistantEvidence(turn: TurnEvidence, info: {
    id?: string;
    finish?: string;
    tokens?: {
        output?: number;
    };
    error?: unknown;
}): void;
export declare function recordTextPart(turn: TurnEvidence, part: {
    messageID?: string;
    type?: string;
    text?: string;
}): void;
export declare function isCompletedEmptyResponse(turn: TurnEvidence): boolean;
//# sourceMappingURL=recovery.d.ts.map