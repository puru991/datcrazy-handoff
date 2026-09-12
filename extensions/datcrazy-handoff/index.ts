/**
 * datcrazy-handoff — autonomous, durable session handoff for the Pi coding agent.
 *
 * What it does
 * ------------
 * `handoff` (tool) or `/datcrazy-handoff resume` writes an artifact plus a
 * per-folder continuation seed, then swaps to a FRESH session that starts on
 * the continuation prompt — no human pressing `/new`.
 *
 * Why it is built this way
 * ------------------------
 * 1. Tool handlers get a base `ExtensionContext`. `newSession` is command-ctx
 *    only (calling it from an event handler or tool body can deadlock). So the
 *    swap needs a command context, and the only way a tool can obtain one is to
 *    dispatch a command: `pi.sendUserMessage("/<cmd>", { expandPromptTemplates: true })`
 *    runs the command handler immediately, even mid-turn, with a real
 *    `ExtensionCommandContext`.
 * 2. Even with a command ctx, `ctx.newSession()` must NOT run inside the live
 *    run: it aborts and waits for the run to become idle, which is the very run
 *    making the call. The controller (swap.ts) therefore waits for an idle tick.
 * 3. The seed is written before any swap attempt, so a crash, a native `/new`,
 *    or a process restart still resumes the work.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  listArtifacts,
  readArtifact,
  readSeed,
  resolveHandoffRoot,
  takeSeed,
  unlinkSeed,
  writeHandoffArtifact,
  writeSeed,
  type HandoffInput,
} from "./artifact.ts";
import { createHandoffController, type HandoffController, type NotifyLevel } from "./swap.ts";

const TOOL_NAME = "handoff";
const COMMAND_NAME = "datcrazy-handoff";
/** Well-known key other datcrazy addons use to reach this runtime. */
const RUNTIME_KEY = Symbol.for("datcrazy-handoff.runtime.v1");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

/** Outcome of trying to arm an in-process swap from this session. */
export type ArmStatus = "armed" | "no-command-ctx" | "unsupported";

/** Runtime published for other addons (datcrazy-remote delegates here). */
export interface HandoffRuntimeV1 {
  version: 1;
  armSwap(
    continuation: string,
    opts?: {
      cwd?: string;
      parentSession?: string;
      artifactPath?: string;
      notify?: (text: string, level?: NotifyLevel) => void;
    },
  ): Promise<ArmStatus>;
  pending(): boolean;
}

// ── Session-scoped state (one module instance == one session) ───────────────

let _pi: ExtensionAPI | null = null;
let _liveCtx: Pick<ExtensionContext, "isIdle" | "cwd" | "ui"> | null = null;
let _cmdCtx: ExtensionCommandContext | null = null;
let _controller: HandoffController | null = null;
let _armToken = "";
let _armAck = "";
let _armNotify: ((text: string, level?: NotifyLevel) => void) | null = null;

function isPrintMode(): boolean {
  const argv = process.argv;
  return argv.includes("-p") || argv.includes("--print");
}

function safeCwd(ctx: Pick<ExtensionContext, "cwd"> | null): string | null {
  try {
    return ctx?.cwd || null;
  } catch {
    return null;
  }
}

function currentCwd(): string {
  return safeCwd(_cmdCtx) ?? safeCwd(_liveCtx) ?? process.cwd();
}

function notify(text: string, level: NotifyLevel = "info"): void {
  const target = _armNotify ?? null;
  if (target) {
    try {
      target(text, level);
      return;
    } catch {
      /* fall through to the live ctx */
    }
  }
  try {
    (_cmdCtx ?? _liveCtx)?.ui?.notify(text, level);
  } catch {
    /* best effort */
  }
}

function sessionFileOf(ctx: Pick<ExtensionContext, "sessionManager"> | null): string {
  try {
    return ctx?.sessionManager?.getSessionFile?.() ?? "";
  } catch {
    return "";
  }
}

// ── Controller ──────────────────────────────────────────────────────────────

async function runSwap(armed: { text: string; cwd: string; parentSession?: string }): Promise<{
  ok: boolean;
  cancelled?: boolean;
  reason?: string;
}> {
  const ctx = _cmdCtx;
  if (!ctx) return { ok: false, reason: "no command context" };
  // Consume the durable seed now: the replacement session must not replay it.
  // A failed swap re-writes it in onFail.
  unlinkSeed(armed.cwd);
  try {
    const result = await ctx.newSession({
      parentSession: armed.parentSession || undefined,
      withSession: async (fresh) => {
        notify("Handoff complete: continuing in a fresh session.", "info");
        try {
          await fresh.sendUserMessage(armed.text);
        } catch {
          // The replacement session already exists; the turn is its problem.
        }
      },
    });
    if (result?.cancelled) {
      return { ok: false, cancelled: true, reason: "cancelled by another extension" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function runDeliver(armed: { text: string }): Promise<{
  ok: boolean;
  cancelled?: boolean;
  reason?: string;
}> {
  try {
    await _pi?.sendUserMessage(armed.text);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function controller(): HandoffController {
  if (_controller) return _controller;
  _controller = createHandoffController({
    tickMs: positiveEnv("DATCRAZY_HANDOFF_TICK_MS"),
    deadlineMs: positiveEnv("DATCRAZY_HANDOFF_SWAP_TIMEOUT_MS"),
    isIdle: () => {
      try {
        return _liveCtx?.isIdle?.() ?? true;
      } catch {
        return true;
      }
    },
    run: async (armed) => (armed.kind === "deliver" ? runDeliver(armed) : runSwap(armed)),
    notify,
    onDone: (armed) => {
      // A delivered seed is consumed only after it actually reached a session.
      if (armed.kind === "deliver") unlinkSeed(armed.cwd);
    },
    onFail: (armed) => {
      // Keep the handoff recoverable: rewrite the durable seed on any failure.
      try {
        writeSeed(armed.cwd, armed.text, { artifactPath: armed.artifactPath });
      } catch {
        /* best effort */
      }
    },
  });
  return _controller;
}

function resetController(): void {
  _controller?.dispose();
  _controller = null;
}

// ── Arming ──────────────────────────────────────────────────────────────────

/**
 * Arms a fresh-session continuation. Acquires a real command context by
 * dispatching our own command through the user-message path (the documented
 * way for a tool to reach a command ctx), then hands the work to the
 * controller, which waits for an idle tick.
 */
async function armContinuation(
  continuation: string,
  opts: {
    cwd: string;
    parentSession?: string;
    artifactPath?: string;
    notifyOverride?: (text: string, level?: NotifyLevel) => void;
  },
): Promise<ArmStatus> {
  if (!_pi || isPrintMode()) return "unsupported";
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  _armToken = token;
  _armAck = "";
  _armNotify = opts.notifyOverride ?? null;
  try {
    await _pi.sendUserMessage(`/${COMMAND_NAME} __arm ${token}`, { expandPromptTemplates: true });
  } catch {
    _armNotify = null;
    _armToken = "";
    return "no-command-ctx";
  }
  if (_armAck !== token) {
    _armNotify = null;
    _armToken = "";
    return "no-command-ctx";
  }
  controller().arm({
    kind: "swap",
    text: continuation,
    cwd: opts.cwd,
    parentSession: opts.parentSession,
    artifactPath: opts.artifactPath,
  });
  controller().kick();
  return "armed";
}

/** Registry/remote entry point — same arming path, explicit options. */
async function armSwap(
  continuation: string,
  opts?: {
    cwd?: string;
    parentSession?: string;
    artifactPath?: string;
    notify?: (text: string, level?: NotifyLevel) => void;
  },
): Promise<ArmStatus> {
  if (!continuation?.trim()) return "unsupported";
  return await armContinuation(continuation, {
    cwd: opts?.cwd ?? currentCwd(),
    parentSession: opts?.parentSession,
    artifactPath: opts?.artifactPath,
    notifyOverride: opts?.notify,
  });
}

// ── Extension factory ───────────────────────────────────────────────────────

const extension = (pi: ExtensionAPI): void => {
  _pi = pi;
  _cmdCtx = null;

  pi.registerTool({
    name: TOOL_NAME,
    label: "Handoff",
    description:
      "Persist a handoff summary for this work and continue it in a fresh session. " +
      "The summary, artifact path and continuation seed are durable: if the session " +
      "cannot be replaced in place, the next session in the same folder resumes it.",
    promptSnippet:
      "Hand off to a fresh session: save a summary, swap sessions, continue automatically",
    promptGuidelines: [
      "Use handoff when the context is long or the owner asks to summarize and continue; it swaps to a fresh session automatically when the turn ends.",
      "Before calling handoff, join or abandon any in-flight subagent lanes and record their state and output paths in the summary.",
      "Write the handoff summary so a session with no prior context can continue: state the goal, decisions made, evidence paths, and the next concrete step.",
    ],
    parameters: Type.Object({
      summary: Type.String({
        description: "Markdown summary of state, decisions, evidence paths and next steps.",
      }),
      goal: Type.Optional(Type.String({ description: "Running goal statement for the continued work." })),
      root: Type.Optional(
        Type.String({ description: "Absolute folder the handoff belongs to; defaults to the session folder." }),
      ),
      artifacts: Type.Optional(
        Type.Array(Type.String(), { description: "Files/folders to preserve and keep working with." }),
      ),
      openQuestions: Type.Optional(
        Type.Array(Type.String(), { description: "Open questions the next session should resolve." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: HandoffInput,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const cwd = safeCwd(ctx) ?? process.cwd();
      const rootDecision = resolveHandoffRoot(cwd, params?.root);
      if (!rootDecision.ok) {
        return {
          content: [{ type: "text", text: rootDecision.message }],
          details: { ok: false, code: rootDecision.code },
        };
      }
      const summary = (params?.summary ?? "").trim();
      if (!summary) {
        return {
          content: [{ type: "text", text: "handoff needs a non-empty summary." }],
          details: { ok: false, code: "invalid_input" },
        };
      }
      if (controller().status().armed) {
        return {
          content: [
            {
              type: "text",
              text:
                "A handoff is already pending for this session and will swap once the " +
                "turn ends. Use /datcrazy-handoff status to inspect or cancel it first.",
            },
          ],
          details: { ok: false, code: "handoff_pending" },
        };
      }

      const written = writeHandoffArtifact(params, {
        cwd: rootDecision.root,
        sessionFile: sessionFileOf(ctx),
      });
      try {
        writeSeed(rootDecision.root, written.artifact.continuation_prompt, {
          artifactPath: written.path,
        });
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text:
                `Artifact written to ${written.path}, but the continuation seed could not be ` +
                `saved (${e instanceof Error ? e.message : String(e)}). Start the next session ` +
                "manually and point it at the artifact.",
            },
          ],
          details: { ok: false, code: "seed_write_failed", handoffPath: written.path },
        };
      }

      const status = await armContinuation(written.artifact.continuation_prompt, {
        cwd: rootDecision.root,
        parentSession: written.artifact.session_file || undefined,
        artifactPath: written.path,
      });

      if (status === "armed") {
        return {
          content: [
            {
              type: "text",
              text:
                `Handoff saved (${written.path}). A fresh session starts as soon as this ` +
                "turn ends and continues from the summary.",
            },
          ],
          details: { ok: true, handoffPath: written.path, status },
        };
      }
      if (status === "unsupported") {
        return {
          content: [
            {
              type: "text",
              text:
                `Handoff saved (${written.path}). This run cannot swap sessions in place, so ` +
                "the continuation seed waits for the next session in this folder — or run " +
                "`/datcrazy-handoff resume` there.",
            },
          ],
          details: { ok: true, handoffPath: written.path, status },
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Handoff saved (${written.path}) but this session could not acquire a session ` +
              "swap context. The seed is durable: run `/datcrazy-handoff resume` or start a " +
              "new session and it will resume automatically.",
          },
        ],
        details: { ok: true, handoffPath: written.path, status },
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description:
      "Handoff: summarize this session and continue in a fresh one " +
      "(status | list | resume [--path <artifact>] | cancel)",
    getArgumentCompletions: async (prefix: string) =>
      ["status", "list", "resume", "cancel"]
        .filter((option) => option.startsWith(prefix))
        .map((option) => ({ value: option, label: option })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      _cmdCtx = ctx;
      const trimmed = args.trim();
      const spaceAt = trimmed.indexOf(" ");
      const head = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
      const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
      const cwd = safeCwd(ctx) ?? process.cwd();

      // Internal: the arm handshake issued by the tool. Acknowledges the token
      // so the caller knows a real command context was captured.
      if (head === "__arm") {
        if (rest === _armToken) {
          _armAck = rest;
          controller().kick();
        }
        return;
      }

      if (head === "" || head === "status") {
        const state = controller().status();
        const seed = readSeed(cwd);
        const lines = [
          state.armed
            ? `Handoff pending (${state.kind}, waiting ${Math.round(state.waitingMs / 1000)}s) for an idle session.`
            : "No handoff pending in memory.",
          seed ? `Continuation seed: ${seed.artifact_path || "(no artifact)"}` : "No continuation seed in this folder.",
        ];
        const recent = listArtifacts(1, { projectRoot: cwd })[0];
        if (recent) lines.push(`Last artifact: ${recent.path}`);
        notify(lines.join("\n"), "info");
        return;
      }

      if (head === "list") {
        const recent = listArtifacts(5, { projectRoot: cwd });
        notify(
          recent.length
            ? recent.map((a) => `${a.created_at}  ${a.path}`).join("\n")
            : "No handoff artifacts for this folder yet.",
          "info",
        );
        return;
      }

      if (head === "cancel") {
        const wasArmed = controller().cancel();
        unlinkSeed(cwd);
        notify(wasArmed ? "Pending handoff cancelled." : "No pending handoff; seed cleared.", "info");
        return;
      }

      if (head === "resume") {
        let continuation = "";
        let artifactPath = "";
        const pathMatch = /--path\s+(.+)$/.exec(rest);
        if (pathMatch) {
          const artifact = readArtifact(pathMatch[1]!.trim().replace(/^"|"$/g, ""));
          if (!artifact) {
            notify(`No readable handoff artifact at ${pathMatch[1]!.trim()}.`, "error");
            return;
          }
          continuation = artifact.continuation_prompt;
          artifactPath = pathMatch[1]!.trim();
        } else {
          const seed = readSeed(cwd);
          if (!seed) {
            const newest = listArtifacts(1, { projectRoot: cwd })[0];
            if (!newest) {
              notify("Nothing to resume: no continuation seed for this folder.", "warning");
              return;
            }
            const artifact = readArtifact(newest.path);
            if (!artifact) {
              notify(`Artifact at ${newest.path} is unreadable.`, "error");
              return;
            }
            continuation = artifact.continuation_prompt;
            artifactPath = newest.path;
          } else {
            continuation = seed.continuation;
            artifactPath = seed.artifact_path;
          }
        }
        const status = await armContinuation(continuation, {
          cwd,
          artifactPath,
          notifyOverride: (text, level) => ctx.ui?.notify?.(text, level ?? "info"),
        });
        if (status === "armed") {
          notify("Handoff armed: a fresh session starts as soon as this turn ends.", "info");
        } else if (status === "no-command-ctx") {
          notify(
            "Could not acquire a session swap context. The seed is saved; start a new session (/new) and it resumes.",
            "warning",
          );
        } else {
          notify(
            "Session swaps are unavailable in this run mode; the continuation seed waits for the next session in this folder.",
            "warning",
          );
        }
        return;
      }

      notify(
        `Unknown subcommand "${head}". Use: status | list | resume [--path <artifact>] | cancel.`,
        "warning",
      );
    },
  });

  pi.on("session_start", (event, ctx) => {
    _liveCtx = ctx;
    _cmdCtx = null;
    _armNotify = null;
    _armToken = "";
    _armAck = "";
    resetController();
    const reason = (event as { reason?: string } | undefined)?.reason ?? "startup";
    // Reload keeps the same session: replaying a seed there would double-deliver.
    if (reason === "reload" || isPrintMode()) return;
    const cwd = safeCwd(ctx);
    if (!cwd) return;
    const seed = readSeed(cwd);
    if (!seed) return;
    notify("Resuming handed-off work in a fresh session.", "info");
    controller().arm({
      kind: "deliver",
      text: seed.continuation,
      cwd,
      artifactPath: seed.artifact_path,
    });
    controller().kick();
  });

  // A turn just settled: this is the earliest safe moment to swap.
  pi.on("agent_settled", () => {
    controller().kick();
  });

  // Interop: other datcrazy addons (datcrazy-remote's datcrazy_handoff tool)
  // delegate the swap here instead of duplicating the command-ctx dance.
  (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = {
    version: 1,
    armSwap,
    pending: () => controller().status().armed,
  } satisfies HandoffRuntimeV1;
};

export default extension;
