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

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
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
}

/** Per-folder seed file consumed by the next session booting in that folder. */
export function seedPathFor(cwd: string): string {
  return join(seedsDir(), `seed-${slugFor(cwd)}-${cwdKey(cwd)}.json`);
}

/** Persists a continuation prompt for the next session in `cwd`. */
export function writeSeed(
  cwd: string,
  continuation: string,
  opts?: { artifactPath?: string; now?: Date },
): string {
  const path = seedPathFor(cwd);
  mkdirSync(seedsDir(), { recursive: true });
  const record: SeedRecord = {
    schema: 1,
    cwd,
    continuation,
    artifact_path: opts?.artifactPath ?? "",
    created_at: (opts?.now ?? new Date()).toISOString(),
  };
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

/** Reads the pending seed for `cwd` WITHOUT consuming it, or null. */
export function readSeed(cwd: string): SeedRecord | null {
  const path = seedPathFor(cwd);
  if (!existsSync(path)) return null;
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
 * Consumes (and removes) the pending seed for `cwd`, or null. A seed written
 * for a different folder that happens to hash the same is left for its owner.
 */
export function takeSeed(cwd: string): SeedRecord | null {
  const record = readSeed(cwd);
  if (record) unlinkSeed(cwd);
  return record;
}

/** Removes the pending seed for `cwd`, if present. */
export function unlinkSeed(cwd: string): void {
  try {
    unlinkSync(seedPathFor(cwd));
  } catch {
    /* already gone */
  }
}
