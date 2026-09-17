/**
 * Handoff artifacts and continuation seeds.
 *
 * A handoff is "summarize, swap to a fresh session, continue". Two durable
 * pieces are written before anything is swapped:
 *
 *   1. An **artifact** under `~/.pi/datcrazy/handoff/artifacts/<utc>-<slug>/handoff.json`
 *      — the archival record (what was done, where, how to continue).
 *   2. A per-folder **continuation seed** `.../seeds/seed-<slug>-<hash>.json`
 *      — consumed by the next session that boots in that folder, so a crash,
 *      a native `/new`, or a restart still resumes the work.
 *
 * The swap itself lives in `swap.ts`; this module is pure storage.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Artifact ────────────────────────────────────────────────────────────────

/** Agent-tool input (mirrors the `handoff` tool parameters). */
export interface HandoffInput {
  /** Agent-written markdown summary of state, decisions and next steps. */
  summary: string;
  /** Optional running goal statement. */
  goal?: string;
  /** Absolute folder the handoff belongs to; defaults to the session cwd. */
  root?: string;
  /** Paths to preserve / keep working with. */
  artifacts?: string[];
  /** Open questions the next session should resolve. */
  openQuestions?: string[];
}

/** On-disk artifact schema. */
export interface HandoffRuntimeState {
  /** Provider/model selected by the live Pi runtime, never from tool arguments. */
  provider: string;
  model: string;
  /** Effective thinking level selected by the live Pi runtime. */
  thinking?: string;
}

export interface HandoffArtifact {
  schema: 1;
  created_at: string;
  project_root: string;
  /** Absolute path of the source Pi session jsonl ("" when unresolvable). */
  session_file: string;
  summary: string;
  goal: string;
  artifacts: string[];
  open_questions: string[];
  continuation_prompt: string;
  /** Runtime selection captured from the active session (old artifacts omit it). */
  runtime?: HandoffRuntimeState;
}

/** A freshly written artifact plus where it landed. */
export interface WrittenHandoff {
  dir: string;
  path: string;
  artifact: HandoffArtifact;
}

/** Storage root; `DATCRAZY_HANDOFF_HOME` overrides the home directory. */
export function handoffHome(): string {
  const home =
    process.env["DATCRAZY_HANDOFF_HOME"] ||
    process.env["HOME"] ||
    process.env["USERPROFILE"] ||
    homedir();
  return join(home, ".pi", "datcrazy", "handoff");
}

export function artifactsDir(): string {
  return join(handoffHome(), "artifacts");
}

export function seedsDir(): string {
  return join(handoffHome(), "seeds");
}

/**
 * Composes the ready-made first user message for the continuation session.
 * The summary is embedded verbatim so a fresh (empty) session resumes without
 * re-reading the artifact.
 */
export function composeContinuationPrompt(summary: string, goal?: string): string {
  const goalBlock = goal?.trim() ? `\n## Goal\n${goal.trim()}\n` : "";
  return (
    "A previous session handed off this work so it could continue in a fresh " +
    "session. Read the summary below, then continue the task.\n" +
    "\n" +
    "## Handoff summary\n" +
    `${summary.trim()}\n` +
    goalBlock +
    "\n## Instructions\n" +
    "Continue the work described above from where it stopped. Begin by stating " +
    "the next concrete step you will take. If the summary lists open questions, " +
    "resolve them or say which need a human."
  );
}

function realpathOrRaw(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Canonical folder identity. Two strings that name the same folder (forward vs
 * back slashes, case differences on Windows, a symlinked path) must resolve to
 * the same seed and compare equal — a handoff written by any tool has to be
 * found by the session that boots in that folder.
 */
export function canonicalCwd(cwd: string): string {
  const resolved = realpathOrRaw(cwd || ".");
  if (process.platform !== "win32") return resolved;
  return resolved.replace(/\//g, "\\").toLowerCase();
}

/** True when two path strings name the same folder. */
export function sameCwd(a: string, b: string): boolean {
  return canonicalCwd(a) === canonicalCwd(b);
}

/** Last path segment, slugified — used in artifact directory names. */
export function slugFor(cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "handoff";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "handoff";
}

/** Stable, filesystem-safe key for a folder (seed filenames). */
export function cwdKey(cwd: string): string {
  return createHash("sha1").update(canonicalCwd(cwd)).digest("hex").slice(0, 12);
}

function stampFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * A handoff stays inside the session's own folder: switching roots mid-flight
 * would silently move the work. Start a session in the target folder first.
 */
export function resolveHandoffRoot(
  cwd: string,
  inputRoot: string | undefined,
): { ok: true; root: string } | { ok: false; code: string; message: string } {
  if (!inputRoot?.trim()) return { ok: true, root: cwd };
  if (sameCwd(inputRoot.trim(), cwd)) return { ok: true, root: cwd };
  const target = realpathOrRaw(inputRoot.trim());
  return {
    ok: false,
    code: "cross_root_unsupported",
    message:
      "A handoff stays within the current session's folder. To hand off in " +
      `"${target}", start a session there first, then hand off.`,
  };
}

/** Writes the artifact JSON. Never throws on a missing optional field. */
export function writeHandoffArtifact(
  input: HandoffInput,
  opts: {
    cwd: string;
    sessionFile?: string;
    now?: Date;
    slugOverride?: string;
    runtime?: HandoffRuntimeState;
  },
): WrittenHandoff {
  const now = opts.now ?? new Date();
  const summary = input.summary.trim();
  const goal = input.goal?.trim() ?? "";
  const artifacts = Array.isArray(input.artifacts)
    ? input.artifacts.filter((a): a is string => typeof a === "string" && a.length > 0)
    : [];
  const openQuestions = Array.isArray(input.openQuestions)
    ? input.openQuestions.filter((q): q is string => typeof q === "string" && q.length > 0)
    : [];
  const artifact: HandoffArtifact = {
    schema: 1,
    created_at: now.toISOString(),
    project_root: opts.cwd,
    session_file: opts.sessionFile ?? "",
    summary,
    goal,
    artifacts,
    open_questions: openQuestions,
    continuation_prompt: composeContinuationPrompt(summary, goal),
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
  };
  const dir = join(
    artifactsDir(),
    `${stampFor(now)}-${opts.slugOverride ?? slugFor(opts.cwd)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "handoff.json");
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
  return { dir, path, artifact };
}

/** Reads one artifact file. Returns null when missing or malformed. */
export function readArtifact(path: string): HandoffArtifact | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HandoffArtifact;
    return typeof parsed?.continuation_prompt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export interface ArtifactSummary {
  path: string;
  dir: string;
  created_at: string;
  project_root: string;
  goal: string;
}

/** Newest-first artifact listing (best effort; unreadable entries skipped).
 *  `projectRoot` restricts the listing to the current folder's handoffs. */
export function listArtifacts(limit = 10, opts?: { projectRoot?: string }): ArtifactSummary[] {
  const root = artifactsDir();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: ArtifactSummary[] = [];
  for (const name of dirs.sort().reverse()) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const path = join(dir, "handoff.json");
    const artifact = readArtifact(path);
    if (!artifact) continue;
    if (opts?.projectRoot && !sameCwd(artifact.project_root, opts.projectRoot)) continue;
    out.push({
      path,
      dir,
      created_at: artifact.created_at,
      project_root: artifact.project_root,
      goal: artifact.goal,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Continuation seed ───────────────────────────────────────────────────────

export interface SeedRecord {
  schema: 1;
  cwd: string;
  continuation: string;
  artifact_path: string;
  created_at: string;
  /** Runtime selection captured from the active session (old seeds omit it). */
  runtime?: HandoffRuntimeState;
  /** Unique generation for atomic, identity-safe consumption (old seeds omit it). */
  generation?: string;
}

/** The pre-generation filename retained for seeds written by older releases. */
function legacySeedPathFor(cwd: string): string {
  return join(seedsDir(), `seed-${slugFor(cwd)}-${cwdKey(cwd)}.json`);
}

function generationSeedPrefix(cwd: string): string {
  return `seed-${slugFor(cwd)}-${cwdKey(cwd)}-`;
}

interface SeedFile {
  path: string;
  record: SeedRecord;
  consumed: boolean;
}

function readSeedFile(path: string, cwd: string): SeedRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SeedRecord;
    if (typeof parsed?.continuation !== "string") return null;
    if (!sameCwd(parsed.cwd ?? "", cwd)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Finds all live generations, including the metadata-free canonical seed from
 * older releases. Generation files are immutable after publication; consuming
 * one renames that exact file, so a newer publication cannot be erased.
 */
function seedFilesFor(cwd: string, includeConsumed = false): SeedFile[] {
  const root = seedsDir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const legacy = legacySeedPathFor(cwd);
  const prefix = generationSeedPrefix(cwd);
  const out: SeedFile[] = [];
  for (const name of names) {
    const consumed = name.endsWith(".json.consumed");
    if (consumed && !includeConsumed) continue;
    const publishedName = consumed ? name.slice(0, -".consumed".length) : name;
    if (join(root, publishedName) !== legacy &&
        (!publishedName.startsWith(prefix) || !publishedName.endsWith(".json"))) continue;
    const path = join(root, name);
    const record = readSeedFile(path, cwd);
    if (record) out.push({ path, record, consumed });
  }
  return out;
}

function generationOrder(record: SeedRecord): string {
  // Deterministic tie-break only: a random generation suffix is not a
  // publication sequence and must never justify consuming a timestamp peer.
  return record.generation ?? `legacy-${record.created_at}`;
}

function activeSeedFile(cwd: string): SeedFile | null {
  const generations = seedFilesFor(cwd, true);
  // A consumed generation remains the durable supersession watermark even if
  // the process crashed before cleaning older files. Equal-time peers remain
  // eligible because random suffixes do not establish publication order.
  let consumedThrough = "";
  for (const file of generations) {
    if (file.consumed && file.record.created_at > consumedThrough) {
      consumedThrough = file.record.created_at;
    }
  }
  const files = generations.filter((file) =>
    !file.consumed && file.record.created_at >= consumedThrough);
  files.sort((a, b) => {
    const created = a.record.created_at.localeCompare(b.record.created_at);
    return created || generationOrder(a.record).localeCompare(generationOrder(b.record));
  });
  return files.at(-1) ?? null;
}

/**
 * Returns the active path. It is dynamic for compatibility with callers that
 * used the old canonical path, but operations capture the returned generation
 * through the serialized record before consuming it.
 */
export function seedPathFor(cwd: string): string {
  return activeSeedFile(cwd)?.path ?? legacySeedPathFor(cwd);
}

function consumedPath(path: string): string {
  return `${path}.consumed`;
}

/** Atomically removes exactly `path`; it never targets the current pointer. */
function consumeSeedPath(path: string): boolean {
  try {
    renameSync(path, consumedPath(path));
    return true;
  } catch {
    return false;
  }
}

/** Persists a continuation prompt as a unique generation. */
export function writeSeed(
  cwd: string,
  continuation: string,
  opts?: { artifactPath?: string; now?: Date; runtime?: HandoffRuntimeState },
): string {
  mkdirSync(seedsDir(), { recursive: true });
  const now = opts?.now ?? new Date();
  const generation = `${now.getTime().toString(36).padStart(12, "0")}-${randomBytes(8).toString("hex")}`;
  const filename = `${generationSeedPrefix(cwd)}${generation}.json`;
  const path = join(seedsDir(), filename);
  const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  const record: SeedRecord = {
    schema: 1,
    cwd,
    continuation,
    artifact_path: opts?.artifactPath ?? "",
    created_at: now.toISOString(),
    generation,
    ...(opts?.runtime ? { runtime: opts.runtime } : {}),
  };
  // Publish only after the complete record is durable at a unique path. No
  // writer ever rewrites a shared latest file.
  writeFileSync(temp, JSON.stringify(record, null, 2) + "\n");
  renameSync(temp, path);
  return path;
}

/** Reads the newest pending generation WITHOUT consuming it, or null. */
export function readSeed(cwd: string): SeedRecord | null {
  return activeSeedFile(cwd)?.record ?? null;
}

/** Reads one captured generation without falling back to a newer publication. */
export function readSeedAtPath(path: string, cwd: string): SeedRecord | null {
  return readSeedFile(path, cwd);
}

/**
 * Atomically consumes the exact serialized generation captured by an operation.
 * A newer seed has a different immutable path and cannot be removed by this.
 */
export function consumeSeed(cwd: string, expected: string): boolean {
  let parsedExpected: SeedRecord;
  try {
    parsedExpected = JSON.parse(expected) as SeedRecord;
  } catch {
    return false;
  }
  const match = seedFilesFor(cwd).find((file) => JSON.stringify(file.record) === JSON.stringify(parsedExpected));
  if (!match || !consumeSeedPath(match.path)) return false;
  // Once a generation is consumed, older generations must not resurrect. A
  // generation published after this scan remains untouched and wins next.
  for (const older of seedFilesFor(cwd)) {
    if (older.path === match.path) continue;
    if (older.record.created_at < match.record.created_at) {
      consumeSeedPath(older.path);
    }
  }
  return true;
}

/** Consumes the active seed, preserving the old take() API. */
export function takeSeed(cwd: string): SeedRecord | null {
  const record = readSeed(cwd);
  if (record && consumeSeed(cwd, JSON.stringify(record))) return record;
  return null;
}

/** Explicitly cancels the currently active generation, if present. */
export function unlinkSeed(cwd: string): void {
  const record = readSeed(cwd);
  if (record) consumeSeed(cwd, JSON.stringify(record));
}
