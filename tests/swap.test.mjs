import test from "node:test";
import assert from "node:assert/strict";

const { createHandoffController } = await import("../extensions/datcrazy-handoff/swap.ts");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function harness(overrides = {}) {
  const state = {
    idle: false,
    runs: [],
    notified: [],
    done: [],
    failed: [],
  };
  const controller = createHandoffController({
    isIdle: () => state.idle,
    run: async (armed) => {
      state.runs.push(armed);
      return overrides.result ?? { ok: true };
    },
    notify: (text, level) => state.notified.push({ text, level }),
    onDone: (armed) => state.done.push(armed),
    onFail: (armed, reason) => state.failed.push({ armed, reason }),
    tickMs: overrides.tickMs ?? 5,
    deadlineMs: overrides.deadlineMs ?? 200,
    ...overrides.options,
  });
  return { state, controller };
}

const ARMED = { kind: "swap", text: "continue", cwd: "/tmp/project" };

test("does not run while busy, runs on the first idle tick", async () => {
  const { state, controller } = harness();
  controller.arm(ARMED);
  controller.kick();
  await sleep(40);
  assert.equal(state.runs.length, 0, "must not swap while the session is busy");
  assert.equal(controller.status().armed, true);

  state.idle = true;
  assert.equal(await waitFor(() => state.runs.length === 1), true);
  assert.equal(await waitFor(() => state.done.length === 1), true);
  assert.equal(controller.status().armed, false);
  assert.equal(state.failed.length, 0);
  assert.match(state.notified.at(-1).text, /Handoff complete/);
});

test("a failed run reports the reason and keeps the caller informed", async () => {
  const { state, controller } = harness({ result: { ok: false, reason: "boom" } });
  state.idle = true;
  controller.arm(ARMED);
  controller.kick();
  assert.equal(await waitFor(() => state.failed.length === 1), true);
  assert.equal(state.failed[0].reason, "boom");
  assert.equal(controller.status().armed, false);
  assert.equal(state.notified.at(-1).level, "error");
  assert.match(state.notified.at(-1).text, /saved/);
});

test("a cancelled run is reported as cancelled, not as an error", async () => {
  const { state, controller } = harness({
    result: { ok: false, cancelled: true, reason: "cancelled by another extension" },
  });
  state.idle = true;
  controller.arm(ARMED);
  controller.kick();
  assert.equal(await waitFor(() => state.failed.length === 1), true);
  assert.equal(state.failed[0].reason, "cancelled");
  assert.equal(state.notified.at(-1).level, "warning");
});

test("a throwing run never escapes the timer", async () => {
  const { state, controller } = harness({
    options: {
      run: async () => {
        throw new Error("kaboom");
      },
    },
  });
  state.idle = true;
  controller.arm(ARMED);
  controller.kick();
  assert.equal(await waitFor(() => state.failed.length === 1), true);
  assert.equal(state.failed[0].reason, "kaboom");
  assert.equal(controller.status().armed, false);
});

test("never-idle sessions time out instead of hanging forever", async () => {
  const { state, controller } = harness({ deadlineMs: 30 });
  controller.arm(ARMED);
  assert.equal(await waitFor(() => state.failed.length === 1), true);
  assert.equal(state.failed[0].reason, "timeout");
  assert.equal(state.notified.at(-1).level, "warning");
  assert.equal(controller.status().armed, false);
  assert.equal(state.runs.length, 0);
});

test("cancel drops the arming before any run", async () => {
  const { state, controller } = harness();
  controller.arm(ARMED);
  assert.equal(controller.status().armed, true);
  assert.equal(controller.cancel(), true);
  state.idle = true;
  await sleep(30);
  assert.equal(state.runs.length, 0);
  assert.equal(controller.cancel(), false);
});

test("a stale idle probe (session already replaced) still yields a run attempt", async () => {
  const { state, controller } = harness({
    options: {
      isIdle: () => {
        throw new Error("stale after session replacement");
      },
    },
  });
  controller.arm(ARMED);
  controller.kick();
  assert.equal(await waitFor(() => state.runs.length === 1), true);
});

test("dispose stops all future work", async () => {
  const { state, controller } = harness();
  controller.arm(ARMED);
  controller.dispose();
  state.idle = true;
  await sleep(30);
  assert.equal(state.runs.length, 0);
});
