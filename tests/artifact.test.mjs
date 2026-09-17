import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "handoff-artifact-"));
process.env.DATCRAZY_HANDOFF_HOME = home;

const {
  composeContinuationPrompt,
  consumeSeed,
  cwdKey,
  listArtifacts,
  readArtifact,
  readSeed,
  resolveHandoffRoot,
  seedPathFor,
  slugFor,
  takeSeed,
  unlinkSeed,
  writeHandoffArtifact,
  writeSeed,
} = await import("../extensions/datcrazy-handoff/artifact.ts");

const CWD = join(home, "project-alpha");

test("composeContinuationPrompt embeds summary, goal and instructions", () => {
  const prompt = composeContinuationPrompt("did the thing", "ship it");
  assert.match(prompt, /did the thing/);
  assert.match(prompt, /## Goal\nship it/);
  assert.match(prompt, /Continue the work described above/);
  const bare = composeContinuationPrompt("did the thing");
  assert.doesNotMatch(bare, /## Goal/);
});

test("writeHandoffArtifact persists a readable artifact and lists newest first", () => {
  const first = writeHandoffArtifact(
    { summary: "first", goal: "g1", artifacts: ["a.md", ""], openQuestions: ["q1", ""] },
    { cwd: CWD, sessionFile: "/tmp/session.jsonl", now: new Date("2026-01-01T00:00:00Z") },
  );
  const second = writeHandoffArtifact(
    { summary: "second" },
    {
      cwd: CWD,
      now: new Date("2026-01-02T00:00:00Z"),
      runtime: { provider: "captured", model: "live", thinking: "high" },
    },
  );

  assert.ok(existsSync(first.path));
  const onDisk = JSON.parse(readFileSync(first.path, "utf8"));
  assert.equal(onDisk.schema, 1);
  assert.equal(onDisk.project_root, CWD);
  assert.equal(onDisk.session_file, "/tmp/session.jsonl");
  assert.deepEqual(onDisk.artifacts, ["a.md"]);
  assert.deepEqual(onDisk.open_questions, ["q1"]);
  assert.match(onDisk.continuation_prompt, /first/);
  assert.deepEqual(readArtifact(second.path).runtime, {
    provider: "captured",
    model: "live",
    thinking: "high",
  });

  const listed = listArtifacts(5);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].path, second.path);
  assert.equal(listed[1].path, first.path);
  assert.equal(listArtifacts(5, { projectRoot: CWD }).length, 2);
  assert.equal(listArtifacts(5, { projectRoot: join(home, "project-beta") }).length, 0);
  assert.equal(readArtifact(first.path).goal, "g1");
  assert.equal(readArtifact(join(home, "nope.json")), null);
});

test("resolveHandoffRoot accepts the session folder and refuses a different root", () => {
  const same = resolveHandoffRoot(CWD, CWD);
  assert.equal(same.ok, true);
  const implicit = resolveHandoffRoot(CWD, undefined);
  assert.equal(implicit.ok, true);
  const other = resolveHandoffRoot(CWD, join(home, "project-beta"));
  assert.equal(other.ok, false);
  assert.equal(other.code, "cross_root_unsupported");
});

test("seed lifecycle: write, read, take (one-shot), unlink", () => {
  const seedPath = writeSeed(CWD, "continue please", { artifactPath: "/tmp/a.json" });
  assert.equal(seedPath, seedPathFor(CWD));
  assert.ok(existsSync(seedPath));

  const read = readSeed(CWD);
  assert.equal(read.continuation, "continue please");
  assert.equal(read.artifact_path, "/tmp/a.json");
  // readSeed must not consume.
  assert.ok(existsSync(seedPath));

  const taken = takeSeed(CWD);
  assert.equal(taken.continuation, "continue please");
  assert.equal(existsSync(seedPath), false);
  assert.equal(readSeed(CWD), null);
  assert.equal(takeSeed(CWD), null);

  writeSeed(CWD, "again", { runtime: { provider: "captured", model: "live", thinking: "high" } });
  assert.deepEqual(readSeed(CWD).runtime, { provider: "captured", model: "live", thinking: "high" });
  unlinkSeed(CWD);
  assert.equal(readSeed(CWD), null);
  unlinkSeed(CWD); // idempotent
});

test("consuming a generation preserves same-millisecond publications from another process", () => {
  const moduleUrl = new URL("../extensions/datcrazy-handoff/artifact.ts", import.meta.url).href;
  const timestamp = "2026-09-17T15:00:00.000Z";
  const publisher = `
    import crypto from "node:crypto";
    import { syncBuiltinESMExports } from "node:module";
    crypto.randomBytes = (size) => Buffer.alloc(size, Number(process.argv[1]));
    syncBuiltinESMExports();
    const { writeSeed } = await import(process.argv[2]);
    console.log(writeSeed(process.argv[3], process.argv[4], { now: new Date(process.argv[5]) }));
  `;
  // Exercise both random-suffix orders with identical timestamps. The suffix
  // identifies a generation; it cannot say which process published first.
  for (const [oldSuffix, newSuffix] of [[255, 0], [0, 255]]) {
    const cwd = join(home, `same-millisecond-${oldSuffix}`);
    const publish = (suffix, continuation) => {
      const child = spawnSync(process.execPath, [
        "--input-type=module", "-e", publisher,
        String(suffix), moduleUrl, cwd, continuation, timestamp,
      ], { encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout.trim();
    };
    const oldPath = publish(oldSuffix, "old continuation");
    const captured = JSON.parse(readFileSync(oldPath, "utf8"));
    const newPath = publish(newSuffix, "new continuation");
    assert.equal(consumeSeed(cwd, JSON.stringify(captured)), true);
    assert.equal(existsSync(newPath), true, "old completion must not consume its timestamp peer");
    assert.equal(readSeed(cwd).continuation, "new continuation");
    assert.equal(takeSeed(cwd).continuation, "new continuation");
    assert.equal(readSeed(cwd), null);
  }
});

test("a consumed-generation marker prevents stale recovery after interrupted cleanup", () => {
  const cwd = join(home, "interrupted-generation-cleanup");
  const oldPath = writeSeed(cwd, "superseded continuation", { now: new Date("2026-09-17T15:00:00.000Z") });
  const newestPath = writeSeed(cwd, "delivered continuation", { now: new Date("2026-09-17T15:00:01.000Z") });
  // Simulate a crash immediately after the delivered generation is consumed,
  // before its older files can be cleaned up.
  renameSync(newestPath, `${newestPath}.consumed`);
  assert.equal(existsSync(oldPath), true);
  assert.equal(readSeed(cwd), null);
  assert.equal(takeSeed(cwd), null);
  writeSeed(cwd, "subsequent handoff", { now: new Date("2026-09-17T15:00:02.000Z") });
  assert.equal(takeSeed(cwd).continuation, "subsequent handoff");
  assert.equal(readSeed(cwd), null);
});

test("a seed for another folder is not stolen", () => {
  const other = join(home, "project-beta");
  writeSeed(other, "beta work");
  assert.equal(readSeed(CWD), null);
  assert.equal(takeSeed(CWD), null);
  assert.equal(readSeed(other).continuation, "beta work");
  unlinkSeed(other);
});

test("slug and key are stable and filesystem-safe", () => {
  assert.equal(slugFor("C:\\Code\\My Project"), "my-project");
  assert.equal(slugFor("/"), "handoff");
  assert.equal(cwdKey(CWD), cwdKey(CWD));
  assert.match(cwdKey(CWD), /^[0-9a-f]{12}$/);
});

test("a seed written with a different path spelling is still found", () => {
  const forward = CWD.replace(/\\/g, "/");
  writeSeed(forward, "same folder, other spelling");
  assert.ok(existsSync(seedPathFor(CWD)));
  assert.equal(readSeed(CWD).continuation, "same folder, other spelling");
  assert.equal(takeSeed(CWD).continuation, "same folder, other spelling");

  if (process.platform === "win32") {
    writeSeed(CWD.toUpperCase(), "upper case spelling");
    assert.equal(readSeed(CWD).continuation, "upper case spelling");
    unlinkSeed(CWD);
  }
});
