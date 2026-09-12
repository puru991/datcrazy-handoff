import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
function createHarness(cwd, { dispatchCommands = true } = {}) {
  const state = {
    idle: false,
    tools: new Map(),
    commands: new Map(),
    events: new Map(),
    newSessionCalls: [],
    freshMessages: [],
    plainMessages: [],
    notified: [],
    failNewSession: false,
    cancelNewSession: false,
    parentSession: "/sessions/parent.jsonl",
  };

  const notify = (text, level) => state.notified.push({ text, level: level ?? "info" });

  const commandCtx = {
    get cwd() {
      return cwd;
    },
    ui: { notify },
    sessionManager: { getSessionFile: () => state.parentSession },
    isIdle: () => state.idle,
    async newSession(options) {
      state.newSessionCalls.push(options);
      if (state.failNewSession) throw new Error("swap exploded");
      if (state.cancelNewSession) return { cancelled: true };
      const fresh = {
        cwd,
        ui: { notify },
        async sendUserMessage(text) {
          state.freshMessages.push(text);
        },
      };
      await options.withSession?.(fresh);
      return { cancelled: false };
    },
  };

  const ctx = {
    cwd,
    ui: { notify },
    sessionManager: { getSessionFile: () => state.parentSession },
    isIdle: () => state.idle,
  };

  const pi = {
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
      ui: { notify },
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
    harness.state.notified.some((n) => /cancel/i.test(n.text)),
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

test("the interop runtime arms a swap for another addon", async () => {
  const harness = createHarness(freshCwd("interop"));
  extension(harness.pi);
  await boot(harness);

  const runtime = globalThis[Symbol.for("datcrazy-handoff.runtime.v1")];
  const status = await runtime.armSwap("delegated continuation", { cwd: harness.cwd });
  assert.equal(status, "armed");
  assert.equal(runtime.pending(), true);

  harness.state.idle = true;
  await harness.emit("agent_settled", {});
  assert.equal(await waitFor(() => harness.state.freshMessages.length === 1), true);
  assert.equal(harness.state.freshMessages[0], "delegated continuation");
});
