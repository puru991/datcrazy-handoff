import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "handoff-successor-"));
process.env.DATCRAZY_HANDOFF_HOME = home;

const { buildSuccessorArgs, resolvePiEntry, spawnSuccessor, successorLogPath, kMaxGenerations } =
  await import("../extensions/datcrazy-handoff/successor.ts");

/** A believable pi entry on disk (the resolver inspects the file). */
const cliDir = mkdtempSync(join(tmpdir(), "handoff-cli-"));
const cliEntry = join(
  cliDir,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
mkdirSync(join(cliDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), {
  recursive: true,
});
writeFileSync(cliEntry, "// fake pi cli\n");

const PI_ARGV = [
  "C:\\Program Files\\nodejs\\node.exe",
  cliEntry,
  "--provider",
  "openai-codex",
  "--model",
  "openai-codex/gpt-5.6-luna",
  "--thinking",
  "xhigh",
  "-e",
  "D:/ext/addon.ts",
  "--tools",
  "handoff,read",
  "-nt",
  "--session-dir",
  "D:/sessions",
  "--api-key",
  "SECRET",
  "--continue",
  "-p",
  "--no-session",
  "--mode",
  "json",
  "--session",
  "abc123",
  "summarize the repo and hand off",
];

test("resolvePiEntry accepts a pi CLI entry and rejects anything else", () => {
  assert.deepEqual(resolvePiEntry(PI_ARGV), { execPath: PI_ARGV[0], entry: cliEntry });
  assert.equal(resolvePiEntry(["node", "tests/run.mjs"]), null, "test runner is not pi");
  assert.equal(resolvePiEntry(["node", join(cliDir, "missing.js")]), null, "missing file");
  assert.equal(resolvePiEntry(["node"]), null);
  assert.equal(resolvePiEntry([]), null);
});

test("successor args keep capability flags and drop session/prompt flags", () => {
  const args = buildSuccessorArgs(PI_ARGV);
  const has = (flag) => args.includes(flag);
  const valueOf = (flag) => args[args.indexOf(flag) + 1];
  // kept
  assert.equal(valueOf("--provider"), "openai-codex");
  assert.equal(valueOf("--model"), "openai-codex/gpt-5.6-luna");
  assert.equal(valueOf("--thinking"), "xhigh");
  assert.equal(valueOf("-e"), "D:/ext/addon.ts");
  assert.equal(valueOf("--tools"), "handoff,read");
  assert.equal(valueOf("--session-dir"), "D:/sessions");
  assert.ok(has("-nt"));
  // dropped: identity, mode, prompts, secrets
  assert.equal(has("--continue"), false);
  assert.equal(has("-p"), false);
  assert.equal(has("--no-session"), false);
  assert.equal(has("--mode"), false);
  assert.equal(has("--session"), false);
  assert.equal(has("--api-key"), false);
  assert.equal(has("SECRET"), false);
  assert.equal(
    args.some((a) => a.includes("summarize the repo")),
    false,
    "the parent prompt is not the successor's work",
  );
  // always one-shot
  assert.equal(args.at(-1), "--print");
});

test("captured runtime replaces stale launch provider, model and thinking flags", () => {
  const args = buildSuccessorArgs([
    "node", cliEntry,
    "--provider", "stale-provider",
    "--model", "stale-provider/stale-model",
    "--thinking", "low",
  ], {
    provider: "captured-provider",
    model: "captured-model",
    thinking: "xhigh",
  });
  assert.equal(args.filter((arg) => arg === "--provider").length, 1);
  assert.equal(args[args.indexOf("--provider") + 1], "captured-provider");
  assert.equal(args[args.indexOf("--model") + 1], "captured-provider/captured-model");
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
});

test("authoritative runtime without thinking drops stale launch thinking", () => {
  const args = buildSuccessorArgs([
    "node", cliEntry,
    "--provider", "stale-provider",
    "--model", "stale-provider/stale-model",
    "--thinking", "low",
  ], {
    provider: "saved-provider",
    model: "saved-model",
    thinkingAuthoritative: true,
  });
  assert.equal(args.includes("--thinking"), false);
  assert.match(args.join(" "), /--provider saved-provider --model saved-provider\/saved-model/);
});

test("successor args add the session dir and model when absent", () => {
  const args = buildSuccessorArgs(["node", cliEntry], {
    sessionDir: "D:/sessions/x",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  const text = args.join(" ");
  assert.match(text, /--session-dir D:\/sessions\/x/);
  assert.match(text, /--provider openai-codex --model openai-codex\/gpt-5\.6-luna/);
  assert.equal(args.at(-1), "--print");
});

const fakeChild = (pid = 4242) => {
  const state = { stdin: "", unrefCalled: false, closed: false };
  return {
    state,
    child: {
      pid,
      stdin: {
        on: () => undefined,
        end: (text) => {
          state.stdin = text;
          state.closed = true;
        },
      },
      unref: () => {
        state.unrefCalled = true;
      },
    },
  };
};

test("spawnSuccessor launches a detached successor with the continuation on stdin", () => {
  const { state, child } = fakeChild();
  const calls = [];
  const result = spawnSuccessor(
    { cwd: home, continuation: "KEEP GOING: finish the refactor", argv: PI_ARGV },
    {
      spawnFn: (command, args, options) => {
        calls.push({ command, args, options });
        return child;
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.pid, 4242);
  assert.ok(result.logPath && existsSync(result.logPath), "successor log is created");
  assert.equal(state.stdin, "KEEP GOING: finish the refactor");
  assert.equal(state.unrefCalled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, PI_ARGV[0]);
  assert.equal(calls[0].args[0], cliEntry);
  assert.equal(calls[0].args.at(-1), "--print");
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.cwd, home);
});

test("a successor is a top-level session: parent identity is stripped, generation bumped", () => {
  const { child } = fakeChild();
  let seenEnv;
  const result = spawnSuccessor(
    {
      cwd: home,
      continuation: "continue",
      argv: PI_ARGV,
      env: {
        PATH: "/usr/bin",
        PI_SESSION_FILE: "/sessions/parent.jsonl",
        PI_SESSION_ID: "parent-id",
        PI_SUBAGENT_PARENT_SESSION: "parent-id",
        DATCRAZY_HANDOFF_GENERATION: "3",
      },
    },
    {
      spawnFn: (_c, _a, options) => {
        seenEnv = options.env;
        return child;
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(seenEnv.PI_SESSION_FILE, undefined);
  assert.equal(seenEnv.PI_SESSION_ID, undefined);
  assert.equal(seenEnv.PI_SUBAGENT_PARENT_SESSION, undefined);
  assert.equal(seenEnv.DATCRAZY_HANDOFF_GENERATION, "4");
  assert.equal(seenEnv.PATH, "/usr/bin");
});

test("a successor chain stops at the generation cap", () => {
  let spawned = 0;
  const result = spawnSuccessor(
    {
      cwd: home,
      continuation: "loop forever",
      argv: PI_ARGV,
      env: { DATCRAZY_HANDOFF_GENERATION: String(kMaxGenerations) },
    },
    {
      spawnFn: () => {
        spawned++;
        return fakeChild().child;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /generations/);
  assert.equal(spawned, 0);
});

test("spawnSuccessor refuses when the host is not pi, and never throws", () => {
  const result = spawnSuccessor(
    { cwd: home, continuation: "go", argv: ["node", "tests/run.mjs"] },
    {
      spawnFn: () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /not identifiable/);
});

test("a spawn failure is reported, not thrown", () => {
  const result = spawnSuccessor(
    { cwd: home, continuation: "go", argv: PI_ARGV },
    {
      spawnFn: () => {
        throw new Error("EACCES");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /EACCES/);
});

test("successor log paths are unique and live under the handoff home", () => {
  const a = successorLogPath(new Date("2026-01-01T00:00:00Z"));
  const b = successorLogPath(new Date("2026-01-01T00:00:01Z"));
  assert.match(a, /logs[\\/]successor-2026-01-01T00-00-00-000Z\.log$/);
  assert.ok(a.startsWith(home), "logs stay inside the handoff home");
  assert.notEqual(a, b);
});
