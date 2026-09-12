/**
 * Successor sessions: when this process cannot swap in place, start a NEW pi
 * process that continues the work.
 *
 * Two cases need it, and they are the two the README used to answer with "start
 * a session yourself":
 *
 *   1. Print mode (`pi -p` / `--mode text|json`). There is no live session to
 *      replace and the process exits when its prompt settles, so an in-process
 *      swap would be cut off. The successor runs the continuation as its own
 *      one-shot prompt.
 *   2. A host that does not dispatch extension commands from user messages.
 *      `ctx.newSession` is command-context only, and the documented way for a
 *      tool to obtain one is to dispatch a command — which that host will not
 *      do. The successor does not need a command context at all.
 *
 * The successor is launched detached with the continuation on its stdin (pi's
 * print mode merges piped stdin into the initial prompt), so the text is never
 * squeezed through a command line. Output goes to a log file under the handoff
 * home. A generation counter bounds a chain in case a model keeps handing off.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { handoffHome } from "./artifact.ts";

/** Parent flags the successor must NOT inherit (each consumes a value). */
const DROPPED_VALUE_FLAGS = new Set([
  "--session",
  "--session-id",
  "--fork",
  "--mode",
  "--export",
  "--name",
  "-n",
  "--api-key", // never propagate a secret through a child's argv
  "--tui-mode",
]);

/** Parent flags worth carrying over (model / capability surface). */
const KEPT_VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--thinking",
  "--models",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--session-dir",
  "--system-prompt",
  "--append-system-prompt",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
]);

/** Boolean switches worth carrying over. */
const KEPT_BOOLEAN_FLAGS = new Set([
  "--no-extensions",
  "-ne",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--offline",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
]);

/** Boolean/optional-value flags to drop (a stray value is dropped as positional). */
const DROPPED_BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--print",
  "-p",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--no-session",
  "--list-models",
]);

export interface PiEntry {
  execPath: string;
  entry: string;
}

/**
 * The pi CLI entry of the CURRENT process, when it can be identified. Returns
 * null for hosts that embed pi some other way — callers then keep the durable
 * seed instead of pretending to have spawned something.
 */
export function resolvePiEntry(argv: readonly string[] = process.argv): PiEntry | null {
  const execPath = argv[0];
  const entry = argv[1];
  if (!execPath || !entry) return null;
  if (!/\.(js|cjs|mjs|ts)$/i.test(entry)) return null;
  const name = basename(entry).toLowerCase();
  if (name !== "cli.js" && !/pi-coding-agent/i.test(entry)) return null;
  try {
    if (!statSync(entry).isFile()) return null;
  } catch {
    return null;
  }
  return { execPath, entry };
}

/**
 * Arguments for the successor: the parent's capability flags minus anything that
 * would resume/proxy the parent's session or its prompt, plus `--print` (the
 * successor owns exactly one turn).
 */
export function buildSuccessorArgs(
  argv: readonly string[],
  opts?: { sessionDir?: string; provider?: string; model?: string },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (flag: string): void => {
    if (!seen.has(flag)) {
      seen.add(flag);
      out.push(flag);
    }
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break; // after this, every word is positional prompt input
    if (DROPPED_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (KEPT_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      push(arg);
      if (value !== undefined && !value.startsWith("-")) {
        out.push(value);
        i++;
      }
      continue;
    }
    if (DROPPED_BOOLEAN_FLAGS.has(arg)) continue;
    if (KEPT_BOOLEAN_FLAGS.has(arg)) {
      push(arg);
      continue;
    }
    // Unknown flags and positionals are never guessed at: the parent's prompt is
    // not the successor's work.
  }
  if (opts?.sessionDir && !seen.has("--session-dir")) {
    out.push("--session-dir", opts.sessionDir);
  }
  if (opts?.provider && opts?.model && !seen.has("--provider")) {
    out.push("--provider", opts.provider, "--model", `${opts.provider}/${opts.model}`);
  }
  out.push("--print");
  return out;
}

/** Generations of successor chaining allowed before we refuse. */
export const kMaxGenerations = 25;

export interface SpawnResult {
  ok: boolean;
  pid?: number;
  logPath?: string;
  reason?: string;
}

export interface SpawnDeps {
  spawnFn?: typeof nodeSpawn;
}

export function successorLogPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(handoffHome(), "logs", `successor-${stamp}.log`);
}

/**
 * Launches a detached successor in `cwd`, writing `continuation` to its stdin.
 * Never throws: a failure is reported so the caller can keep its durable seed.
 */
export function spawnSuccessor(
  spec: {
    cwd: string;
    continuation: string;
    sessionDir?: string;
    provider?: string;
    model?: string;
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
  },
  deps: SpawnDeps = {},
): SpawnResult {
  const argv = spec.argv ?? process.argv;
  const entry = resolvePiEntry(argv);
  if (!entry) return { ok: false, reason: "pi CLI entry not identifiable" };

  const env: NodeJS.ProcessEnv = { ...(spec.env ?? process.env) };
  const generation = Number(env["DATCRAZY_HANDOFF_GENERATION"] ?? "0") || 0;
  if (generation >= kMaxGenerations) {
    return {
      ok: false,
      reason: `successor chain reached ${kMaxGenerations} generations; not starting another`,
    };
  }

  let logPath = "";
  let logFd: number;
  try {
    mkdirSync(join(handoffHome(), "logs"), { recursive: true });
    logPath = successorLogPath();
    logFd = openSync(logPath, "a");
  } catch (e) {
    return {
      ok: false,
      reason: `could not open a successor log: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // A successor is a top-level session: never inherit the parent's identity.
  delete env["PI_SESSION_FILE"];
  delete env["PI_SESSION_ID"];
  delete env["PI_SUBAGENT_PARENT_SESSION"];
  env["DATCRAZY_HANDOFF_GENERATION"] = String(generation + 1);

  const args = buildSuccessorArgs(argv, {
    sessionDir: spec.sessionDir,
    provider: spec.provider,
    model: spec.model,
  });

  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = (deps.spawnFn ?? nodeSpawn)(entry.execPath, [entry.entry, ...args], {
      cwd: spec.cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["pipe", logFd, logFd],
    });
  } catch (e) {
    try {
      closeSync(logFd);
    } catch { /* best effort */ }
    return { ok: false, logPath, reason: e instanceof Error ? e.message : String(e) };
  }

  try {
    child.stdin?.on("error", () => { /* the child may exit before reading */ });
    child.stdin?.end(spec.continuation);
    child.unref();
    closeSync(logFd);
  } catch (e) {
    try {
      closeSync(logFd);
    } catch { /* best effort */ }
    return { ok: false, logPath, reason: e instanceof Error ? e.message : String(e) };
  }

  if (typeof child.pid !== "number") {
    return { ok: false, logPath, reason: "successor did not report a process id" };
  }
  return { ok: true, pid: child.pid, logPath };
}
