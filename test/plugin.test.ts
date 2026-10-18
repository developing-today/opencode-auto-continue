import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// ─── Harness ────────────────────────────────────────────────────────────────

interface TestEvent {
  id: string;
  created: number;
  type: string;
  data: Record<string, unknown>;
  location?: { directory?: string; workspaceID?: string };
}

type Emit = (
  type: string,
  data: Record<string, unknown>,
  location?: { directory?: string; workspaceID?: string },
) => Promise<void>;

function makeEventStream() {
  const queue: TestEvent[] = [];
  let notify: (() => void) | undefined;
  let stopped = false;
  return {
    push(event: TestEvent) {
      queue.push(event);
      notify?.();
    },
    stop() {
      stopped = true;
      notify?.();
    },
    async *stream(options?: { signal?: AbortSignal }) {
      const signal = options?.signal;
      while (!stopped && !signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next as never;
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          signal?.addEventListener("abort", done, { once: true });
          notify = () => {
            signal?.removeEventListener("abort", done);
            resolve();
          };
        });
        notify = undefined;
      }
    },
  };
}

async function createHarness(
  overrides: Record<string, unknown> = {},
  opts: { workspaceID?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "auto-continue-test-"));
  roots.push(directory);
  await mkdir(join(directory, ".opencode"));
  await writeFile(
    join(directory, ".opencode", "opencode-auto-continue.jsonc"),
    JSON.stringify({ delayMs: 0, throttleMs: 0, ...overrides }),
  );

  const prompts: Array<Record<string, unknown>> = [];
  const interrupts: Array<Record<string, unknown>> = [];
  const synthetics: Array<Record<string, unknown>> = [];
  const commands = new Map<string, (input: unknown) => Promise<void>>();
  const toolHooks = new Map<string, (event: unknown) => Promise<void> | void>();
  const stream = makeEventStream();
  let seq = 0;

  const ctx = {
    location: { directory, workspaceID: opts.workspaceID },
    session: {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input);
        return { id: `msg_prompt_${prompts.length}`, sessionID: input.sessionID, type: "user" };
      },
      interrupt: async (input: Record<string, unknown>) => {
        interrupts.push(input);
      },
      // Simulate real ordering: the session.inbox.delivered event can be
      // published before the synthetic() call resolves.
      synthetic: async (input: Record<string, unknown>) => {
        synthetics.push(input);
        stream.push({
          id: `evt-${seq++}`,
          created: Date.now(),
          type: "session.inbox.delivered",
          data: { sessionID: input.sessionID, inboxID: input.id },
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          id: input.id,
          sessionID: input.sessionID,
          type: "synthetic",
          payload: { text: input.text },
          delivery: "steer",
        };
      },
    },
    command: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (def: { name: string; execute: (input: unknown) => Promise<void> }) => {
            commands.set(def.name, def.execute);
          },
        });
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name: string, cb: (event: unknown) => Promise<void> | void) => {
        toolHooks.set(name, cb);
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => stream.stream(options),
    },
  };

  const cleanupFn = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);

  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    stream.stop();
    await cleanupFn?.();
  };
  cleanups.push(cleanup);

  // Events are pushed without crossing a macrotask boundary, mirroring V1's
  // synchronous hook dispatch: consecutive events are handled before any
  // pending 0ms timer can fire between them.
  const event: Emit = async (type, data, location) => {
    stream.push({ id: `evt-${seq++}`, created: Date.now(), type, data, location });
    await Promise.resolve();
  };

  const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

  const runToolHook = async (name: string, hookEvent: Record<string, unknown>) => {
    const hook = toolHooks.get(name);
    if (!hook) throw new Error(`tool hook "${name}" was not registered`);
    await hook(hookEvent);
  };

  const runCommand = async (name: string, argsText: string, sessionID = "session-1") => {
    const execute = commands.get(name);
    if (!execute) throw new Error(`command "${name}" was not registered`);
    await execute({ sessionID, prompt: { text: argsText }, delivery: "steer" });
  };

  return {
    directory,
    event,
    settle,
    runToolHook,
    runCommand,
    commands,
    prompts,
    interrupts,
    synthetics,
    cleanup,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TOKENS = (output: number) => ({ input: 10, output, reasoning: 0, cache: { read: 0, write: 0 } });
const RETRYABLE_ERROR = { type: "provider.transport", message: "SSE read timed out" };

async function userTurn(event: Emit, inboxID = "user-1") {
  await event("session.inbox.delivered", { sessionID: "session-1", inboxID });
}

async function emptyAssistant(event: Emit, id = "assistant-empty") {
  await event("session.step.ended", {
    sessionID: "session-1",
    assistantMessageID: id,
    finish: "unknown",
    tokens: TOKENS(0),
    cost: 0,
  });
}

async function retryableFailure(event: Emit) {
  await event("session.execution.failed", { sessionID: "session-1", error: RETRYABLE_ERROR });
}

async function retryableStepFailure(event: Emit, id = "assistant-1") {
  await event("session.step.failed", {
    sessionID: "session-1",
    assistantMessageID: id,
    error: RETRYABLE_ERROR,
  });
}

async function idle(event: Emit) {
  await event("session.idle", { sessionID: "session-1" });
}

async function busy(event: Emit) {
  await event("session.status", { sessionID: "session-1", status: { type: "busy" } });
}

// ─── Empty response recovery ────────────────────────────────────────────────

describe("empty response recovery", () => {
  test("continues a completed empty assistant response on idle", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await emptyAssistant(event);
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionID: "session-1", text: "continue" });
  });

  test("continues an empty response when no idle event is emitted", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await emptyAssistant(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("keeps an empty-response retry when the delivered inbox event repeats", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event, "user-1");
    await emptyAssistant(event);
    await userTurn(event, "user-1");
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("continues an unknown zero-output response that contains partial text", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await emptyAssistant(event);
    await event("session.text.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-empty",
      ordinal: 1,
      text: "partial result",
    });
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("allows empty response recovery to be disabled", async () => {
    const { event, prompts, settle } = await createHarness({ retryEmptyResponses: false });
    await userTurn(event);
    await emptyAssistant(event);
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("does not continue a normal reply or tool-calls completion", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-normal",
      finish: "stop",
      tokens: TOKENS(20),
      cost: 0,
    });
    await event("session.text.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-normal",
      ordinal: 1,
      text: "Done",
    });
    await idle(event);
    await event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-tool",
      finish: "tool-calls",
      tokens: TOKENS(10),
      cost: 0,
    });
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("continues when the assistant after a tool call is empty", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-tool",
      finish: "tool-calls",
      tokens: TOKENS(10),
      cost: 0,
    });
    await event("session.text.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-tool",
      ordinal: 1,
      text: "Running tool",
    });
    await emptyAssistant(event, "assistant-after-tool");
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("does not continue after interruption, question, or permission requests", async () => {
    for (const blocked of ["interrupt", "question-tool", "question-form", "permission"] as const) {
      const { event, runToolHook, prompts, settle } = await createHarness();
      await userTurn(event);
      await emptyAssistant(event);
      if (blocked === "interrupt") {
        await event("session.execution.interrupted", { sessionID: "session-1", reason: "user" });
      } else if (blocked === "question-tool") {
        await runToolHook("execute.before", {
          tool: "question",
          sessionID: "session-1",
          agent: "build",
          messageID: "msg-1",
          id: "call-1",
          input: {},
        });
      } else if (blocked === "question-form") {
        await event("form.created", {
          form: { id: "form-1", sessionID: "session-1", title: "Pick one", fields: [] },
        });
      } else {
        await event("permission.asked", {
          id: "perm-1",
          sessionID: "session-1",
          action: "edit",
          resources: [],
        });
      }
      await idle(event);
      await settle();

      expect(prompts).toHaveLength(0);
    }
  });

  test("question and permission waits cancel an explicit-error retry", async () => {
    for (const blocked of ["question-tool", "question-form", "permission"] as const) {
      const { event, runToolHook, prompts, settle } = await createHarness();
      await userTurn(event);
      await retryableStepFailure(event);
      if (blocked === "question-tool") {
        await runToolHook("execute.before", {
          tool: "question",
          sessionID: "session-1",
          agent: "build",
          messageID: "msg-1",
          id: "call-1",
          input: {},
        });
      } else if (blocked === "question-form") {
        await event("form.created", {
          form: { id: "form-1", sessionID: "session-1", title: "Pick one", fields: [] },
        });
      } else {
        await event("permission.asked", {
          id: "perm-1",
          sessionID: "session-1",
          action: "edit",
          resources: [],
        });
      }
      await idle(event);
      await settle();

      expect(prompts).toHaveLength(0);
    }
  });

  test("a question or permission reply releases the guard", async () => {
    for (const released of ["form", "permission"] as const) {
      const { event, prompts, settle } = await createHarness();
      await userTurn(event);
      if (released === "form") {
        await event("form.created", {
          form: { id: "form-1", sessionID: "session-1", title: "Pick one", fields: [] },
        });
        await event("form.replied", { id: "form-1", sessionID: "session-1", answer: [] });
      } else {
        await event("permission.asked", {
          id: "perm-1",
          sessionID: "session-1",
          action: "edit",
          resources: [],
        });
        await event("permission.replied", {
          sessionID: "session-1",
          requestID: "perm-1",
          reply: "once",
        });
      }
      // The guard is released before the error occurs — the retry must go through.
      await retryableStepFailure(event);
      await idle(event);
      await settle();

      expect(prompts).toHaveLength(1);
    }
  });

  test("cancels a queued retry when a late stop arrives", async () => {
    const { event, prompts, settle } = await createHarness({ delayMs: 25 });
    await userTurn(event);
    await emptyAssistant(event);
    await idle(event);
    await event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-empty",
      finish: "stop",
      tokens: TOKENS(10),
      cost: 0,
    });
    await settle(40);

    expect(prompts).toHaveLength(0);
  });

  test("deduplicates repeated idle events", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await emptyAssistant(event);
    await idle(event);
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("honors throttle and maximum consecutive retries", async () => {
    const throttled = await createHarness({ throttleMs: 30 });
    await userTurn(throttled.event, "user-1");
    await emptyAssistant(throttled.event, "empty-1");
    await idle(throttled.event);
    await throttled.settle(5);
    await userTurn(throttled.event, "user-2");
    await emptyAssistant(throttled.event, "empty-2");
    await idle(throttled.event);
    await throttled.settle(5);
    await throttled.settle(40);
    expect(throttled.prompts).toHaveLength(2);

    const limited = await createHarness({ maxConsecutive: 2 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await userTurn(limited.event, `user-${attempt}`);
      await emptyAssistant(limited.event, `empty-${attempt}`);
      await idle(limited.event);
      await limited.settle();
    }
    expect(limited.prompts).toHaveLength(2);
  });

  test("resets consecutive retries after finish stop", async () => {
    const { event, prompts, settle } = await createHarness({ maxConsecutive: 1 });
    await userTurn(event, "user-1");
    await emptyAssistant(event, "empty-1");
    await idle(event);
    await settle();

    await userTurn(event, "user-2");
    await event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-success",
      finish: "stop",
      tokens: TOKENS(10),
      cost: 0,
    });
    await userTurn(event, "user-3");
    await emptyAssistant(event, "empty-2");
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(2);
  });
});

// ─── Stalled request recovery ───────────────────────────────────────────────

describe("stalled request recovery", () => {
  test("interrupts a busy request without assistant activity and continues after idle", async () => {
    const { event, prompts, interrupts, settle } = await createHarness({
      stalledRequestTimeoutMs: 15,
    });
    await userTurn(event);
    await busy(event);
    await settle(25);

    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]).toEqual({ sessionID: "session-1", resume: false });
    expect(prompts).toHaveLength(0);

    await event("session.execution.interrupted", { sessionID: "session-1", reason: "user" });
    await event("session.status", { sessionID: "session-1", status: { type: "idle" } });
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("does not restart the watchdog on duplicate busy events", async () => {
    const { event, interrupts, settle } = await createHarness({ stalledRequestTimeoutMs: 20 });
    await userTurn(event);
    await busy(event);
    await settle(12);
    await busy(event);
    await settle(12);

    expect(interrupts).toHaveLength(1);
  });

  test("does not abort after real assistant activity", async () => {
    const activities = [
      ["text", "session.text.ended", { assistantMessageID: "assistant-active", ordinal: 1, text: "activity" }],
      ["text-delta", "session.text.delta", { assistantMessageID: "assistant-active", ordinal: 1, delta: "chunk" }],
      ["reasoning", "session.reasoning.ended", { assistantMessageID: "assistant-active", ordinal: 1, text: "thinking" }],
      ["tool", "session.tool.called", { assistantMessageID: "assistant-active", id: "tool-1", input: {}, executed: false }],
      ["streamed", "session.step.streamed", { assistantMessageID: "assistant-active" }],
    ] as const;

    for (const [, type, data] of activities) {
      const { event, interrupts, settle } = await createHarness({ stalledRequestTimeoutMs: 15 });
      await userTurn(event);
      await busy(event);
      await event(type, { sessionID: "session-1", ...data });
      await settle(25);

      expect(interrupts).toHaveLength(0);
    }

    const tokens = await createHarness({ stalledRequestTimeoutMs: 15 });
    await userTurn(tokens.event);
    await busy(tokens.event);
    await tokens.event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-active",
      finish: "unknown",
      tokens: TOKENS(1),
      cost: 0,
    });
    await tokens.settle(25);
    expect(tokens.interrupts).toHaveLength(0);
  });

  test("does not abort user-cancelled, question, permission, or disabled watchdog turns", async () => {
    for (const blocked of ["interrupt", "question", "permission", "disabled"] as const) {
      const { event, runToolHook, interrupts, settle } = await createHarness({
        stalledRequestTimeoutMs: blocked === "disabled" ? 0 : 15,
      });
      await userTurn(event);
      await busy(event);
      if (blocked === "interrupt") {
        await event("session.execution.interrupted", { sessionID: "session-1", reason: "user" });
      } else if (blocked === "question") {
        await runToolHook("execute.before", {
          tool: "question",
          sessionID: "session-1",
          agent: "build",
          messageID: "msg-1",
          id: "call-1",
          input: {},
        });
      } else if (blocked === "permission") {
        await event("permission.asked", {
          id: "perm-1",
          sessionID: "session-1",
          action: "edit",
          resources: [],
        });
      }
      await settle(25);

      expect(interrupts).toHaveLength(0);
    }
  });
});

// ─── V2 execution lifecycle ─────────────────────────────────────────────────

describe("v2 execution lifecycle", () => {
  test("continues after session.execution.failed without any idle event", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await retryableFailure(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("does not double-retry when OpenCode retries the failed step itself", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await retryableStepFailure(event);
    await event("session.retry.scheduled", {
      sessionID: "session-1",
      assistantMessageID: "assistant-1",
      attempt: 2,
      at: Date.now(),
      error: RETRYABLE_ERROR,
    });
    await event("session.step.started", {
      sessionID: "session-1",
      assistantMessageID: "assistant-2",
      agent: "build",
      model: { providerID: "anthropic", id: "claude" },
      started: Date.now(),
    });
    await event("session.step.ended", {
      sessionID: "session-1",
      assistantMessageID: "assistant-2",
      finish: "stop",
      tokens: TOKENS(10),
      cost: 0,
    });
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("continues once the internal retries are exhausted and the turn fails", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await retryableStepFailure(event, "assistant-1");
    await event("session.retry.scheduled", {
      sessionID: "session-1",
      assistantMessageID: "assistant-1",
      attempt: 2,
      at: Date.now(),
      error: RETRYABLE_ERROR,
    });
    await event("session.step.started", {
      sessionID: "session-1",
      assistantMessageID: "assistant-2",
      agent: "build",
      model: { providerID: "anthropic", id: "claude" },
      started: Date.now(),
    });
    await retryableStepFailure(event, "assistant-2");
    await retryableFailure(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("a user interruption cancels the pending retry", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await retryableFailure(event);
    await event("session.execution.interrupted", { sessionID: "session-1", reason: "user" });
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("session.deleted clears per-session state and timers", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event, "user-1");
    await retryableFailure(event);
    await event("session.deleted", { sessionID: "session-1" });
    await settle();
    expect(prompts).toHaveLength(0);

    // State is recreated cleanly for a follow-up turn in the same session.
    await userTurn(event, "user-2");
    await retryableFailure(event);
    await idle(event);
    await settle();
    expect(prompts).toHaveLength(1);
  });

  test("ignores events that carry a foreign location directory", async () => {
    const { event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event(
      "session.step.failed",
      { sessionID: "session-1", assistantMessageID: "assistant-1", error: RETRYABLE_ERROR },
      { directory: "/foreign/project" },
    );
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(0);
  });

  test("handles events that carry the plugin's own location", async () => {
    const { directory, event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event(
      "session.step.failed",
      { sessionID: "session-1", assistantMessageID: "assistant-1", error: RETRYABLE_ERROR },
      { directory },
    );
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("keeps same-directory events when only the event carries a workspaceID", async () => {
    const { directory, event, prompts, settle } = await createHarness();
    await userTurn(event);
    await event(
      "session.step.failed",
      { sessionID: "session-1", assistantMessageID: "assistant-1", error: RETRYABLE_ERROR },
      { directory, workspaceID: "ws-9" },
    );
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("filters same-directory events from a different workspace when scoped", async () => {
    const { directory, event, prompts, settle } = await createHarness({}, { workspaceID: "ws-own" });
    await userTurn(event);
    await event(
      "session.step.failed",
      { sessionID: "session-1", assistantMessageID: "assistant-1", error: RETRYABLE_ERROR },
      { directory, workspaceID: "ws-other" },
    );
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(0);

    await event(
      "session.step.failed",
      { sessionID: "session-1", assistantMessageID: "assistant-2", error: RETRYABLE_ERROR },
      { directory, workspaceID: "ws-own" },
    );
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });
});

// ─── Slash commands ─────────────────────────────────────────────────────────

describe("slash commands", () => {
  test("registers /auto-continue and /ac", async () => {
    const { commands } = await createHarness();
    expect(commands.has("auto-continue")).toBe(true);
    expect(commands.has("ac")).toBe(true);
  });

  test("command output renders via synthetic messages without a model prompt", async () => {
    const { runCommand, prompts, synthetics, settle } = await createHarness();
    await runCommand("auto-continue", "status");

    expect(prompts).toHaveLength(0);
    expect(synthetics).toHaveLength(1);
    expect(synthetics[0].resume).toBe(false);
    expect(typeof synthetics[0].id).toBe("string");
    expect((synthetics[0].id as string).startsWith("msg_")).toBe(true);
    expect(String(synthetics[0].text)).toContain("Auto-Continue Status");
    await settle();
  });

  test("/ac on enables a globally disabled session", async () => {
    const { event, runCommand, prompts, settle } = await createHarness({ enabled: false });
    await userTurn(event);
    await retryableFailure(event);
    await idle(event);
    await settle();
    expect(prompts).toHaveLength(0);

    await runCommand("ac", "on");
    await userTurn(event, "user-2");
    await retryableFailure(event);
    await idle(event);
    await settle();
    expect(prompts).toHaveLength(1);
  });

  test("/ac off during the delay window cancels the pending continue", async () => {
    const { event, runCommand, prompts, settle } = await createHarness({ delayMs: 25 });
    await userTurn(event);
    await retryableFailure(event);
    await idle(event);
    await runCommand("ac", "off");
    await settle(40);

    expect(prompts).toHaveLength(0);
  });

  test("/ac global off during the delay window cancels pending retries", async () => {
    const { directory, event, runCommand, prompts, settle } = await createHarness({ delayMs: 25 });
    await userTurn(event);
    await retryableFailure(event);
    await idle(event);
    await runCommand("ac", "global off");
    await settle(40);

    expect(prompts).toHaveLength(0);
    const saved = JSON.parse(
      await readFile(join(directory, ".opencode", "opencode-auto-continue.jsonc"), "utf-8"),
    );
    expect(saved.enabled).toBe(false);
  });

  test("re-enabling does not resurrect a cancelled retry", async () => {
    const { event, runCommand, prompts, settle } = await createHarness({ delayMs: 25 });
    await userTurn(event);
    await retryableFailure(event);
    await idle(event);
    await runCommand("ac", "off");
    await runCommand("ac", "on");
    await settle(40);

    expect(prompts).toHaveLength(0);
  });

  test("/ac max limits session retries", async () => {
    const { event, runCommand, prompts, settle } = await createHarness();
    await runCommand("ac", "max 1");
    await userTurn(event, "user-1");
    await retryableFailure(event);
    await idle(event);
    await settle();
    await userTurn(event, "user-2");
    await retryableFailure(event);
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("/ac global throttle persists to the config file", async () => {
    const { directory, runCommand, settle } = await createHarness();
    await runCommand("ac", "global throttle 123");

    const saved = JSON.parse(
      await readFile(join(directory, ".opencode", "opencode-auto-continue.jsonc"), "utf-8"),
    );
    expect(saved.throttleMs).toBe(123);
    await settle();
  });

  test("/ac reset clears session overrides", async () => {
    const { event, runCommand, prompts, settle } = await createHarness();
    await runCommand("ac", "off");
    await runCommand("ac", "reset");
    await userTurn(event);
    await retryableFailure(event);
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });

  test("unknown subcommand replies with help", async () => {
    const { runCommand, synthetics, settle } = await createHarness();
    await runCommand("ac", "bogus");

    expect(synthetics).toHaveLength(1);
    expect(String(synthetics[0].text)).toContain("Unknown");
    await settle();
  });

  test("command output delivered before the synthetic call resolves does not reset retry state", async () => {
    const { event, runCommand, prompts, settle } = await createHarness();
    await userTurn(event);
    await retryableStepFailure(event);
    await settle();
    // The harness synthetic() publishes session.inbox.delivered before it
    // resolves — the plugin must recognize it as its own output.
    await runCommand("ac", "status");
    await settle();
    await idle(event);
    await settle();

    expect(prompts).toHaveLength(1);
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

describe("cleanup", () => {
  test("dispose cancels armed watchdog timers", async () => {
    const { event, interrupts, settle, cleanup } = await createHarness({
      stalledRequestTimeoutMs: 15,
    });
    await userTurn(event);
    await busy(event);
    await cleanup();
    await settle(25);

    expect(interrupts).toHaveLength(0);
  });
});
