import { describe, expect, test } from "bun:test";
import {
  createTurnEvidence,
  isCompletedEmptyResponse,
  recordTextPart,
  updateAssistantEvidence,
} from "../src/recovery.js";

describe("completed empty response detection", () => {
  test("accepts an unknown zero-output assistant completion", () => {
    const turn = createTurnEvidence();
    updateAssistantEvidence(turn, {
      id: "assistant-1",
      finish: "unknown",
      tokens: { output: 0 },
    });

    expect(isCompletedEmptyResponse(turn)).toBe(true);
  });

  test.each([
    ["normal stop", { finish: "stop", output: 10, text: "done" }],
    ["tool call", { finish: "tool-calls", output: 10, text: "" }],
    ["unknown with output", { finish: "unknown", output: 1, text: "" }],
  ])("rejects %s", (_name, value) => {
    const turn = createTurnEvidence();
    updateAssistantEvidence(turn, {
      id: "assistant-1",
      finish: value.finish,
      tokens: { output: value.output },
    });
    recordTextPart(turn, {
      messageID: "assistant-1",
      type: "text",
      text: value.text,
    });

    expect(isCompletedEmptyResponse(turn)).toBe(false);
  });

  test("accepts partial text from an unknown zero-output completion", () => {
    const turn = createTurnEvidence();
    updateAssistantEvidence(turn, {
      id: "assistant-1",
      finish: "unknown",
      tokens: { output: 0 },
    });
    recordTextPart(turn, {
      messageID: "assistant-1",
      type: "text",
      text: "partial",
    });

    expect(isCompletedEmptyResponse(turn)).toBe(true);
  });

  test("tracks text only for the latest assistant message", () => {
    const turn = createTurnEvidence();
    updateAssistantEvidence(turn, {
      id: "tool-message",
      finish: "tool-calls",
      tokens: { output: 20 },
    });
    recordTextPart(turn, {
      messageID: "tool-message",
      type: "text",
      text: "Running a tool",
    });
    updateAssistantEvidence(turn, {
      id: "empty-message",
      finish: "unknown",
      tokens: { output: 0 },
    });

    expect(isCompletedEmptyResponse(turn)).toBe(true);
  });

  test("rejects errors, aborts, questions, and permissions", () => {
    for (const blocked of ["error", "aborted", "question", "permission"] as const) {
      const turn = createTurnEvidence();
      updateAssistantEvidence(turn, {
        id: "assistant-1",
        finish: "unknown",
        tokens: { output: 0 },
        error: blocked === "error" ? { message: "failed" } : undefined,
      });
      if (blocked === "aborted") turn.aborted = true;
      if (blocked === "question") turn.waitingForQuestion = true;
      if (blocked === "permission") turn.waitingForPermission = true;

      expect(isCompletedEmptyResponse(turn)).toBe(false);
    }
  });
});
