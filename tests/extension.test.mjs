import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const home = mkdtempSync(join(tmpdir(), "handoff-ext-"));
process.env.DATCRAZY_HANDOFF_HOME = home;
process.env.DATCRAZY_HANDOFF_TICK_MS = "5";
process.env.DATCRAZY_HANDOFF_SWAP_TIMEOUT_MS = "2000";

const extension = (await import("../extensions/datcrazy-handoff/index.ts")).default;
const { _setSpawnForTest } = await import("../extensions/datcrazy-handoff/index.ts");
const { readSeed, seedPathFor, writeHandoffArtifact, writeSeed } = await import(
  "../extensions/datcrazy-handoff/artifact.ts"
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Publish through a genuinely separate Node process to exercise generation identity. */
function publishExternalSeed(cwd, continuation, runtime) {
  const artifactUrl = new URL("../extensions/datcrazy-handoff/artifact.ts", import.meta.url).href;
  const script = `const { writeSeed } = await import(${JSON.stringify(artifactUrl)}); const runtime = process.env.TEST_SEED_RUNTIME ? JSON.parse(process.env.TEST_SEED_RUNTIME) : undefined; writeSeed(process.env.TEST_SEED_CWD, process.env.TEST_SEED_TEXT, { runtime });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: resolve(".."),
    env: { ...process.env, TEST_SEED_CWD: cwd, TEST_SEED_TEXT: continuation, TEST_SEED_RUNTIME: runtime ? JSON.stringify(runtime) : "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || "external seed publisher failed");
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/** Each test gets its own folder so seeds/artifacts never leak across tests. */
function freshCwd(label) {
  return mkdtempSync(join(home, `cwd-${label}-`));
}

/**
 * A fake Pi whose `sendUserMessage` mirrors the SDK: a leading `/command` with
 * `expandPromptTemplates` runs the registered command handler immediately, even
 * mid-turn, with a full command context.
 */
function createHarness(cwd, { dispatchCommands = true, model = { provider: "live-provider", id: "live-model" }, thinkingLevel = "high" } = {}) {
  const state = {
    idle: false,
    model,
    thinkingLevel,
    tools: new Map(),
    commands: new Map(),
    events: new Map(),
    newSessionCalls: [],
    freshMessages: [],
    plainMessages: [],
    deliveries: [],
    notified: [],
    statuses: new Map(),
    failNewSession: false,
    cancelNewSession: false,
    simulateReplacement: true,
    replacementExtension: null,
    onFreshContinuation: null,
    failFreshContinuation: false,
    parentSession: "/sessions/parent.jsonl",
    models: model ? new Map([[`${model.provider}/${model.id}`, model]]) : new Map(),
  };

  const notify = (text, level) => state.notified.push({ text, level: level ?? "info" });
  const ui = {
    notify,
    setStatus: (key, text) => state.statuses.set(key, text),
  };

  const modelRegistry = {
    find: (provider, id) => state.models.get(`${provider}/${id}`),
  };
  const commandCtx = {
    get cwd() {
      return cwd;
    },
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    modelRegistry,
    ui,
    sessionManager: { getSessionFile: () => state.parentSession },
    isIdle: () => state.idle,
    async newSession(options) {
      state.newSessionCalls.push(options);
      if (state.failNewSession) throw new Error("swap exploded");
      if (state.cancelNewSession) return { cancelled: true };
      if (state.simulateReplacement) {
        // Re-run the factory and startup hook to model Pi's fresh extension
        // instance before invoking withSession.
        (state.replacementExtension ?? extension)(pi);
        await emit("session_start", { reason: "new" });
      }
      const fresh = {
        cwd,
        ui,
        get model() {
          return state.model;
        },
        get thinkingLevel() {
          return state.thinkingLevel;
        },
        modelRegistry,
        async sendUserMessage(text, options) {
          if (dispatchCommands && options?.expandPromptTemplates && typeof text === "string" && text.startsWith("/")) {
            const space = text.indexOf(" ");
            const name = space === -1 ? text.slice(1) : text.slice(1, space);
            const args = space === -1 ? "" : text.slice(space + 1);
            const command = state.commands.get(name);
            if (command) {
              await command.handler(args, { ...commandCtx, cwd, modelRegistry, model: state.model, thinkingLevel: state.thinkingLevel });
              return;
            }
          }
          await state.onFreshContinuation?.(text);
          if (state.failFreshContinuation) throw new Error("continuation rejected");
          state.freshMessages.push(text);
          state.deliveries.push({ text, provider: state.model?.provider, model: state.model?.id, thinking: state.thinkingLevel });
        },
      };
      await options.withSession?.(fresh);
      return { cancelled: false };
    },
  };

  const ctx = {
    cwd,
    ui,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    modelRegistry,
    sessionManager: { getSessionFile: () => state.parentSession },
    isIdle: () => state.idle,
  };

  const pi = {
    async setModel(next) {
      state.model = next;
      return true;
    },
    getThinkingLevel() {
      return state.thinkingLevel;
    },
    setThinkingLevel(level) {
      state.thinkingLevel = level;
    },
    registerTool(tool) {
      state.tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      state.commands.set(name, command);
    },
    on(event, handler) {
      const list = state.events.get(event) ?? [];
      list.push(handler);
      state.events.set(event, list);
    },
    async sendUserMessage(text, options) {
      if (dispatchCommands && options?.expandPromptTemplates && typeof text === "string" && text.startsWith("/")) {
        const space = text.indexOf(" ");
        const name = space === -1 ? text.slice(1) : text.slice(1, space);
        const args = space === -1 ? "" : text.slice(space + 1);
        const command = state.commands.get(name);
        if (command) {
          await command.handler(args, commandCtx);
          return;
        }
      }
      state.plainMessages.push(text);
    },
  };

  async function emit(event, payload) {
    for (const handler of state.events.get(event) ?? []) await handler(payload, ctx);
  }

  function callTool(params) {
    return state.tools.get("handoff").execute("call-1", params, undefined, undefined, {
      cwd,
      ui,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      modelRegistry,
      sessionManager: { getSessionFile: () => state.parentSession },
    });
  }

  return { pi, state, ctx, emit, commandCtx, callTool, cwd };
}

function boot(harness, reason = "startup") {
  return harness.emit("session_start", { reason });
}

test("registers the handoff tool, the command and the interop runtime", async () => {
  const harness = createHarness(freshCwd("register"));
  extension(harness.pi);
  assert.ok(harness.state.tools.has("handoff"));
  assert.ok(harness.state.commands.has("datcrazy-handoff"));
  const runtime = globalThis[Symbol.for("datcrazy-handoff.runtime.v1")];
  assert.equal(runtime.version, 1);
  assert.equal(typeof runtime.armSwap, "function");
});

test("tool -> arm handshake -> fresh session receives the continuation", async () => {
  const harness = createHarness(freshCwd("swap"));
  extension(harness.pi);
  await boot(harness);

  const result = await harness.callTool({ summary: "did the work", goal: "finish it" });
  assert.equal(result.details.status, "armed");
  assert.ok(existsSync(result.details.handoffPath));
  assert.equal(harness.state.newSessionCalls.length, 0, "must not swap before the turn settles");

  // The turn ends: idle + agent_settled kicks the controller.
  harness.state.idle = true;
  await harness.emit("agent_settled", {});

  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.match(harness.state.freshMessages[0], /did the work/);
  assert.match(harness.state.freshMessages[0], /finish it/);
  assert.equal(harness.state.newSessionCalls[0].parentSession, "/sessions/parent.jsonl");
  assert.equal(existsSync(seedPathFor(harness.cwd)), false, "seed is consumed by a successful swap");
  assert.ok(
    harness.state.notified.some((n) => /Handoff complete/.test(n.text)),
    "the swap is announced on the live UI",
  );
});

test("a session that never ran a command still swaps (the old failure mode)", async () => {
  const harness = createHarness(freshCwd("no-command"));
  extension(harness.pi);
  await boot(harness);
  // Nothing else happens here: no `/datcrazy-remote` command, no captured ctx.
  const result = await harness.callTool({ summary: "resume me" });
  assert.equal(result.details.status, "armed");

  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.match(harness.state.freshMessages[0], /resume me/);
});

test("a failed swap keeps the durable seed for the next session", async () => {
  const harness = createHarness(freshCwd("fail"));
  extension(harness.pi);
  await boot(harness);
  await harness.callTool({ summary: "fragile work" });

  harness.state.idle = true;
  harness.state.failNewSession = true;
  await harness.emit("agent_settled", {});

  assert.equal(await waitFor(() => harness.state.notified.some((n) => n.level === "error")), true);
  const seed = readSeed(harness.cwd);
  assert.ok(seed, "seed must survive a failed swap");
  assert.match(seed.continuation, /fragile work/);
});

test("a cancelled swap keeps the seed and says so", async () => {
  const harness = createHarness(freshCwd("cancel"));
  extension(harness.pi);
  await boot(harness);
  await harness.callTool({ summary: "cancelled work" });

  harness.state.idle = true;
  harness.state.cancelNewSession = true;
  await harness.emit("agent_settled", {});

  assert.equal(await waitFor(() => harness.state.notified.some((n) => n.level === "warning")), true);
  assert.ok(readSeed(harness.cwd), "a cancelled swap must not lose the continuation");
});

test("without command dispatch the tool reports no swap context and the seed survives", async () => {
  const harness = createHarness(freshCwd("nodispatch"), { dispatchCommands: false });
  extension(harness.pi);
  await boot(harness);

  const result = await harness.callTool({ summary: "manual resume" });
  assert.equal(result.details.status, "no-command-ctx");
  assert.match(result.content[0].text, /\/datcrazy-handoff resume/);
  const seed = readSeed(harness.cwd);
  assert.ok(seed);
  assert.match(seed.continuation, /manual resume/);

  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(harness.state.freshMessages.length, 0);
});

test("a pending seed is delivered on the next session start", async () => {
  const cwd = freshCwd("boot");
  const harness = createHarness(cwd);
  extension(harness.pi);
  writeSeed(cwd, "boot continuation", { artifactPath: "/artifacts/x/handoff.json" });

  harness.state.idle = true;
  await boot(harness);

  assert.equal(await waitFor(() => harness.state.plainMessages.length === 1), true);
  assert.equal(harness.state.plainMessages[0], "boot continuation");
  assert.equal(existsSync(seedPathFor(cwd)), false, "delivered seeds are consumed");
});

test("a reload never replays a pending seed", async () => {
  const cwd = freshCwd("reload");
  const harness = createHarness(cwd);
  extension(harness.pi);
  writeSeed(cwd, "should wait");
  harness.state.idle = true;
  await boot(harness, "reload");
  await sleep(40);
  assert.equal(harness.state.plainMessages.length, 0);
  assert.ok(existsSync(seedPathFor(cwd)));
});

test("the tool refuses a cross-root handoff and an empty summary", async () => {
  const harness = createHarness(freshCwd("guards"));
  extension(harness.pi);
  await boot(harness);

  const cross = await harness.callTool({
    summary: "elsewhere",
    root: join(home, "some-other-project"),
  });
  assert.equal(cross.details.code, "cross_root_unsupported");

  const empty = await harness.callTool({ summary: "   " });
  assert.equal(empty.details.code, "invalid_input");
  assert.equal(existsSync(seedPathFor(harness.cwd)), false);
});

test("/datcrazy-handoff status, resume and cancel work from the command surface", async () => {
  const harness = createHarness(freshCwd("slash"));
  extension(harness.pi);
  await boot(harness);
  const command = harness.state.commands.get("datcrazy-handoff");

  await command.handler("status", harness.commandCtx);
  assert.match(harness.state.notified.at(-1).text, /No handoff pending/);

  await command.handler("resume", harness.commandCtx);
  assert.match(harness.state.notified.at(-1).text, /Nothing to resume/);
  writeSeed(harness.cwd, "resume via slash command", { artifactPath: "/artifacts/y/handoff.json" });
  await command.handler("resume", harness.commandCtx);
  assert.match(harness.state.notified.at(-1).text, /Handoff armed/);

  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.equal(harness.state.freshMessages[0], "resume via slash command");

  await command.handler("list", harness.commandCtx);
  await command.handler("cancel", harness.commandCtx);
  assert.ok(
    harness.state.notified.some((n) => /cancel|cleared|No pending/i.test(n.text)),
    "cancel reports the cleared state",
  );
  await waitFor(() => harness.state.notified.some((n) => /cancel/i.test(n.text)));
});

test("another folder's handoff is never resumed here", async () => {
  const mine = freshCwd("scope-mine");
  const theirs = freshCwd("scope-theirs");
  const harness = createHarness(mine);
  extension(harness.pi);
  await boot(harness);

  writeSeed(theirs, "other project work");
  writeHandoffArtifact({ summary: "other project work" }, { cwd: theirs });

  await harness.state.commands.get("datcrazy-handoff").handler("resume", harness.commandCtx);
  assert.match(harness.state.notified.at(-1).text, /Nothing to resume/);

  await harness.state.commands.get("datcrazy-handoff").handler("list", harness.commandCtx);
  assert.match(harness.state.notified.at(-1).text, /No handoff artifacts for this folder/);
});

test("print mode starts a successor process instead of waiting for a session", async () => {
  const harness = createHarness(freshCwd("print"));
  extension(harness.pi);
  await boot(harness);
  const originalArgv = [...process.argv];
  process.argv.push("-p");
  const calls = [];
  _setSpawnForTest((spec) => {
    calls.push(spec);
    return { ok: true, pid: 4242, logPath: "/logs/successor.log" };
  });
  try {
    const result = await harness.callTool({ summary: "print mode work" });
    assert.equal(result.details.status, "spawned");
    assert.match(result.content[0].text, /successor pi process/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].continuation, /print mode work/);
    assert.equal(calls[0].cwd, harness.cwd);
    assert.equal(
      existsSync(seedPathFor(harness.cwd)),
      false,
      "the successor carries the text, so the seed is consumed",
    );
    assert.ok(
      harness.state.notified.some((n) => /successor session started/.test(n.text)),
      "the successor is announced with its log path",
    );
  } finally {
    _setSpawnForTest(null);
    process.argv.length = 0;
    process.argv.push(...originalArgv);
  }
});

test("print mode keeps the durable seed when no successor can start", async () => {
  const harness = createHarness(freshCwd("print-nospawn"));
  extension(harness.pi);
  await boot(harness);
  const originalArgv = [...process.argv];
  process.argv.push("-p");
  try {
    const result = await harness.callTool({ summary: "cannot spawn here" });
    assert.equal(result.details.status, "unsupported");
    assert.ok(readSeed(harness.cwd), "the seed waits for the next session");
  } finally {
    process.argv.length = 0;
    process.argv.push(...originalArgv);
  }
});

test("a host without command dispatch gets a successor process", async () => {
  const harness = createHarness(freshCwd("nodispatch-spawn"), { dispatchCommands: false });
  extension(harness.pi);
  await boot(harness);
  const calls = [];
  _setSpawnForTest((spec) => {
    calls.push(spec);
    return { ok: true, pid: 777, logPath: "/logs/s.log" };
  });
  try {
    const result = await harness.callTool({ summary: "dispatch is broken here" });
    assert.equal(result.details.status, "spawned");
    assert.equal(calls.length, 1);
    assert.match(calls[0].continuation, /dispatch is broken here/);
    assert.equal(existsSync(seedPathFor(harness.cwd)), false);
  } finally {
    _setSpawnForTest(null);
  }
});

test("loading the addon shows the product home, once per version", async () => {
  const cwd = freshCwd("announce");
  const harness = createHarness(cwd);
  extension(harness.pi);
  // Earlier tests in this file already booted once, which writes the per-version
  // announcement marker. Clear it so this test observes the first-load notice.
  const announceDir = join(home, ".pi", "datcrazy", "handoff");
  for (const file of readdirSync(announceDir, { withFileTypes: true })) {
    if (file.name.startsWith(".announced-")) rmSync(join(announceDir, file.name), { force: true });
  }
  await boot(harness);

  assert.equal(
    harness.state.statuses.get("datcrazy-handoff"),
    "datcrazy-handoff · pi.datcrazy.co",
    "the footer carries the product home while the addon is loaded",
  );
  const notices = harness.state.notified.filter((n) => /pi\.datcrazy\.co/.test(n.text));
  assert.equal(notices.length, 1, "first load announces the home once");
  assert.match(notices[0].text, /datcrazy-handoff \d+\.\d+\.\d+ installed/);

  // A later session in the same install must not repeat the announcement.
  await boot(harness);
  assert.equal(
    harness.state.notified.filter((n) => /installed — handoff docs/.test(n.text)).length,
    1,
    "the announcement is one-time per version",
  );
  assert.equal(harness.state.statuses.get("datcrazy-handoff"), "datcrazy-handoff · pi.datcrazy.co");
});

test("the command surface names the product home", async () => {
  const harness = createHarness(freshCwd("cmd-desc"));
  extension(harness.pi);
  const described = harness.state.commands.get("datcrazy-handoff");
  assert.match(described.description, /pi\.datcrazy\.co/);
});

test("the interop runtime arms a swap for another addon", async () => {
  const harness = createHarness(freshCwd("interop"));
  extension(harness.pi);
  await boot(harness);

  const runtime = globalThis[Symbol.for("datcrazy-handoff.runtime.v1")];
  const status = await runtime.armSwap("delegated continuation", { cwd: harness.cwd });
  assert.equal(status, "armed");
  assert.equal(runtime.pending(), true);
  assert.deepEqual(readSeed(harness.cwd).runtime, {
    provider: "live-provider",
    model: "live-model",
    thinking: "high",
  });

  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.equal(harness.state.freshMessages[0], "delegated continuation");
  assert.deepEqual(harness.state.deliveries[0], {
    text: "delegated continuation",
    provider: "live-provider",
    model: "live-model",
    thinking: "high",
  });
});

test("replacement restores captured runtime through the fresh extension command before continuation", async () => {
  const harness = createHarness(freshCwd("fresh-runtime"), {
    model: { provider: "captured-provider", id: "captured-model" },
    thinkingLevel: "xhigh",
  });
  extension(harness.pi);
  await boot(harness);
  const result = await harness.callTool({ summary: "captured state" });
  assert.equal(result.details.status, "armed");
  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.equal(harness.state.freshMessages[0].includes("captured state"), true);
  assert.deepEqual(harness.state.deliveries[0], {
    text: harness.state.freshMessages[0],
    provider: "captured-provider",
    model: "captured-model",
    thinking: "xhigh",
  });
  assert.equal(harness.state.plainMessages.some((text) => /^(\/model|\/thinking)\b/.test(text)), false);
});

test("unavailable captured runtime sends no continuation and retains the seed", async () => {
  const harness = createHarness(freshCwd("unavailable-runtime"));
  extension(harness.pi);
  await boot(harness);
  const result = await harness.callTool({ summary: "must not prompt" });
  assert.equal(result.details.status, "armed");
  harness.state.models.clear();
  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.notified.some((n) => n.level === "error")), true);
  assert.equal(harness.state.freshMessages.length, 0, "failed model selection must not send an LLM prompt");
  assert.ok(readSeed(harness.cwd), "failed selection keeps the seed recoverable");
});

test("resume uses saved runtime over the model selected by the launching shell", async () => {
  const target = { provider: "saved-provider", id: "saved-model" };
  const harness = createHarness(freshCwd("saved-runtime"), {
    model: { provider: "stale-provider", id: "stale-model" },
    thinkingLevel: "low",
  });
  harness.state.models.set("saved-provider/saved-model", target);
  extension(harness.pi);
  await boot(harness);
  writeSeed(harness.cwd, "resume with saved state", {
    runtime: { provider: "saved-provider", model: "saved-model", thinking: "high" },
  });
  await harness.state.commands.get("datcrazy-handoff").handler("resume", harness.commandCtx);
  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.deepEqual(harness.state.deliveries[0], {
    text: "resume with saved state",
    provider: "saved-provider",
    model: "saved-model",
    thinking: "high",
  });
});

test("new handoffs fail explicitly when the live runtime cannot be captured", async () => {
  const harness = createHarness(freshCwd("missing-runtime"), { model: null });
  extension(harness.pi);
  await boot(harness);
  const result = await harness.callTool({ summary: "no runtime" });
  assert.equal(result.details.code, "runtime_unavailable");
  assert.equal(readSeed(harness.cwd), null);
});

test("cache-busted fresh addon module coordinates restoration and preserves a newer seed", async () => {
  const freshModule = await import(`../extensions/datcrazy-handoff/index.ts?fresh=${Date.now()}-success`);
  const harness = createHarness(freshCwd("cross-module-success"));
  harness.state.replacementExtension = freshModule.default;
  harness.state.onFreshContinuation = async () => {
    publishExternalSeed(harness.cwd, "next handoff from continuing session", {
      provider: "next-provider",
      model: "next-model",
      thinking: "low",
    });
  };
  extension(harness.pi);
  await boot(harness);
  await harness.callTool({ summary: "old continuation" });
  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.equal(readSeed(harness.cwd).continuation, "next handoff from continuing session");
  assert.deepEqual(readSeed(harness.cwd).runtime, {
    provider: "next-provider",
    model: "next-model",
    thinking: "low",
  });
});

test("cache-busted fresh module ACKs the old callback and does not overwrite a newer seed on rejection", async () => {
  const freshModule = await import(`../extensions/datcrazy-handoff/index.ts?fresh=${Date.now()}-failure`);
  const harness = createHarness(freshCwd("cross-module-failure"));
  harness.state.replacementExtension = freshModule.default;
  harness.state.onFreshContinuation = async () => {
    publishExternalSeed(harness.cwd, "next handoff after rejection", {
      provider: "next-provider",
      model: "next-model",
    });
  };
  harness.state.failFreshContinuation = true;
  extension(harness.pi);
  await boot(harness);
  await harness.callTool({ summary: "rejected old continuation" });
  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.notified.some((n) => n.level === "error")), true);
  assert.equal(readSeed(harness.cwd).continuation, "next handoff after rejection");
});
