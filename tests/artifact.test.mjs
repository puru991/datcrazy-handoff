import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "handoff-artifact-"));
process.env.DATCRAZY_HANDOFF_HOME = home;

const {
  composeContinuationPrompt,
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
    { cwd: CWD, now: new Date("2026-01-02T00:00:00Z") },
  );

  assert.ok(existsSync(first.path));
  const onDisk = JSON.parse(readFileSync(first.path, "utf8"));
  assert.equal(onDisk.schema, 1);
  assert.equal(onDisk.project_root, CWD);
  assert.equal(onDisk.session_file, "/tmp/session.jsonl");
  assert.deepEqual(onDisk.artifacts, ["a.md"]);
  assert.deepEqual(onDisk.open_questions, ["q1"]);
  assert.match(onDisk.continuation_prompt, /first/);

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

  writeSeed(CWD, "again");
  unlinkSeed(CWD);
  assert.equal(readSeed(CWD), null);
  unlinkSeed(CWD); // idempotent
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
