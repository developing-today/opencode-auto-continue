import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHarness(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "auto-continue-test-"));
  roots.push(directory);
  await mkdir(join(directory, ".opencode"));
  await writeFile(
    join(directory, ".opencode", "opencode-auto-continue.jsonc"),
    JSON.stringify({ offlineMode: true, delayMs: 0, throttleMs: 0, ...overrides }),
  );

  const prompts: unknown[] = [];
  const hooks = await plugin({
    directory,
    client: {
      session: {
        promptAsync: async (request: unknown) => {
          prompts.push(request);
          return {};
        },
      },
    },
  } as never);

  const event = async (type: string, properties: Record<string, unknown>) => {
    await hooks.event?.({ event: { type, properties } } as never);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  return { hooks, event, prompts, settle };
}

async function userTurn(event: (type: string, properties: Record<string, unknown>) => Promise<void>) {
  await event("message.updated", {
    info: { id: "user-1", sessionID: "session-1", role: "user" },
  });
}

async function emptyAssistant(
  event: (type: string, properties: Record<string, unknown>) => Promise<void>,
  id = "assistant-empty",
) {
  await event("message.updated", {
    info: {
      id,
      sessionID: "session-1",
      role: "assistant",
      finish: "unknown",
      tokens: { output: 0 },
    },
  });
}

describe("empty response recovery", () => {
  test("continues a completed empty assistant response on idle", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await emptyAssistant(event);
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("allows empty response recovery to be disabled", async () => {
    const { event, prompts, settle } = await createHarness({ retryEmptyResponses: false });
    await userTurn(event);
    await emptyAssistant(event);
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("does not continue a normal reply or tool-calls completion", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event("message.updated", {
      info: {
        id: "assistant-normal",
        sessionID: "session-1",
        role: "assistant",
        finish: "stop",
        tokens: { output: 20 },
      },
    });
    await event("message.part.updated", {
      part: {
        sessionID: "session-1",
        messageID: "assistant-normal",
        type: "text",
        text: "Done",
      },
    });
    await event("session.idle", { sessionID: "session-1" });
    await event("message.updated", {
      info: {
        id: "assistant-tool",
        sessionID: "session-1",
        role: "assistant",
        finish: "tool-calls",
        tokens: { output: 10 },
      },
    });
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("continues when the assistant after a tool call is empty", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event("message.updated", {
      info: {
        id: "assistant-tool",
        sessionID: "session-1",
        role: "assistant",
        finish: "tool-calls",
        tokens: { output: 10 },
      },
    });
    await event("message.part.updated", {
      part: {
        sessionID: "session-1",
        messageID: "assistant-tool",
        type: "text",
        text: "Running tool",
      },
    });
    await emptyAssistant(event, "assistant-after-tool");
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("does not continue after abort, question, or permission requests", async () => {
    for (const blocked of ["abort", "question", "question-event", "permission", "permission-v2"] as const) {
      const { hooks, event, prompts, settle } = await createHarness();
      await userTurn(event);
      await emptyAssistant(event);
      if (blocked === "abort") {
        await event("session.error", {
          sessionID: "session-1",
          error: { name: "MessageAbortedError", message: "operation was aborted" },
        });
      } else if (blocked === "question") {
        await hooks["tool.execute.before"]?.({ sessionID: "session-1", tool: "question" } as never, {} as never);
      } else if (blocked === "question-event") {
        await event("question.asked", { sessionID: "session-1" });
      } else if (blocked === "permission") {
        await event("permission.updated", { sessionID: "session-1" });
      } else {
        await event("permission.asked", { sessionID: "session-1" });
      }
      await event("session.idle", { sessionID: "session-1" });
      await settle();

      expect(prompts).toHaveLength(0);
    }
  });

  test("question and permission waits cancel an explicit-error retry", async () => {
    for (const blocked of ["question", "permission", "permission-v2"] as const) {
      const { hooks, event, prompts, settle } = await createHarness();
      await event("session.error", {
        sessionID: "session-1",
        error: { name: "APIError", message: "SSE read timed out" },
      });
      if (blocked === "question") {
        await hooks["tool.execute.before"]?.({ sessionID: "session-1", tool: "question" } as never, {} as never);
      } else if (blocked === "permission") {
        await event("permission.updated", { sessionID: "session-1" });
      } else {
        await event("permission.v2.asked", { sessionID: "session-1" });
      }
      await event("session.idle", { sessionID: "session-1" });
      await settle();

      expect(prompts).toHaveLength(0);
    }
  });

  test("cancels a queued retry when a late stop arrives", async () => {
    const { event, prompts, settle } = await createHarness({ delayMs: 25 });
    await userTurn(event);
    await emptyAssistant(event);
    await event("session.idle", { sessionID: "session-1" });
    await event("message.updated", {
      info: {
        id: "assistant-empty",
        sessionID: "session-1",
        role: "assistant",
        finish: "stop",
        tokens: { output: 10 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("deduplicates repeated idle events", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await emptyAssistant(event);
    await event("session.idle", { sessionID: "session-1" });
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("honors throttle and maximum consecutive retries", async () => {
    const throttled = await createHarness({ throttleMs: 30 });
    await userTurn(throttled.event);
    await emptyAssistant(throttled.event, "empty-1");
    await throttled.event("session.idle", { sessionID: "session-1" });
    await throttled.settle();
    await userTurn(throttled.event);
    await emptyAssistant(throttled.event, "empty-2");
    await throttled.event("session.idle", { sessionID: "session-1" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(throttled.prompts).toHaveLength(2);

    const limited = await createHarness({ maxConsecutive: 2 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await userTurn(limited.event);
      await emptyAssistant(limited.event, `empty-${attempt}`);
      await limited.event("session.idle", { sessionID: "session-1" });
      await limited.settle();
    }
    expect(limited.prompts).toHaveLength(2);
  });

  test("resets consecutive retries after finish stop", async () => {
    const { event, prompts, settle } = await createHarness({ maxConsecutive: 1 });
    await userTurn(event);
    await emptyAssistant(event, "empty-1");
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    await userTurn(event);
    await event("message.updated", {
      info: {
        id: "assistant-success",
        sessionID: "session-1",
        role: "assistant",
        finish: "stop",
        tokens: { output: 10 },
      },
    });
    await userTurn(event);
    await emptyAssistant(event, "empty-2");
    await event("session.idle", { sessionID: "session-1" });
    await settle();

    expect(prompts).toHaveLength(2);
  });
});
