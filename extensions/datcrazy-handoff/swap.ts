/**
 * The swap controller: decides WHEN the session may be replaced.
 *
 * Pi forbids replacing a session from inside a live run. `ctx.newSession()`
 * tears the current session down (`AgentSession.abort()` -> `waitForIdle()`),
 * so calling it from a tool body or from an `agent_end` handler deadlocks
 * against the very turn that is making the call. The controller therefore owns
 * a timer: an armed continuation is attempted only once the session reports
 * idle, and it is retried on every tick until the deadline.
 *
 * Everything here is dependency-injected (clock, timers, idle probe, runner)
 * so it is unit-testable without Pi.
 */

export type NotifyLevel = "info" | "warning" | "error";

/** Why an armed continuation is waiting. */
export type ArmedKind =
  /** Replace this session and deliver the text in the replacement. */
  | "swap"
  /** Deliver the text to this session (already fresh — boot drain). */
  | "deliver";

export interface ArmedHandoff {
  kind: ArmedKind;
  text: string;
  cwd: string;
  parentSession?: string;
  artifactPath?: string;
  /** Exact serialized seed owned by this operation, for compare-and-consume. */
  seedKey?: string;
  /** Captured active provider/model/thinking selection, if available. */
  runtime?: { provider: string; model: string; thinking?: string };
}

export interface RunResult {
  ok: boolean;
  cancelled?: boolean;
  reason?: string;
}

export interface ControllerOptions {
  /** Live idle probe for the CURRENT session (may be rebound after a swap). */
  isIdle: () => boolean;
  /** Performs the armed work. Must never be called while the run is active. */
  run: (armed: ArmedHandoff) => Promise<RunResult>;
  notify: (text: string, level: NotifyLevel) => void;
  /** Called after a successful run (e.g. consume the durable seed). */
  onDone?: (armed: ArmedHandoff) => void;
  /** Called when a run fails, is cancelled, or times out. */
  onFail?: (armed: ArmedHandoff, reason: string) => void;
  tickMs?: number;
  deadlineMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface HandoffController {
  /** Arms a continuation and starts ticking. Replaces any previous arming. */
  arm(armed: ArmedHandoff): void;
  /** Attempts the armed continuation now (no-op when not armed or in flight). */
  kick(): void;
  /** Drops the in-memory arming (the durable seed is untouched). */
  cancel(): boolean;
  status(): { armed: boolean; kind: ArmedKind | null; inFlight: boolean; waitingMs: number };
  dispose(): void;
}

const DEFAULT_TICK_MS = 250;
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

export function createHandoffController(opts: ControllerOptions): HandoffController {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn =
    opts.clearIntervalFn ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let armed: ArmedHandoff | null = null;
  let armedAt = 0;
  let timer: unknown = null;
  let inFlight = false;
  let disposed = false;

  const unref = (handle: unknown): void => {
    (handle as { unref?: () => void } | null)?.unref?.();
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  const startTimer = (): void => {
    if (timer !== null || disposed) return;
    timer = setIntervalFn(() => tick(), tickMs);
    unref(timer);
  };

  const release = (): void => {
    armed = null;
    stopTimer();
  };

  const tick = (): void => {
    if (disposed || inFlight) return;
    if (!armed) {
      stopTimer();
      return;
    }
    if (now() - armedAt > deadlineMs) {
      const stalled = armed;
      release();
      opts.notify(
        "Handoff is still pending but this session never went idle. The summary " +
          "is saved; the continuation resumes in the next session in this folder " +
          "or via /datcrazy-handoff resume.",
        "warning",
      );
      opts.onFail?.(stalled, "timeout");
      return;
    }
    let idle = false;
    try {
      idle = opts.isIdle();
    } catch {
      // A stale context means the session was already replaced by someone else.
      // Leave the durable seed alone; the next session boot resumes it.
      idle = true;
    }
    if (!idle) return;

    const next = armed;
    inFlight = true;
    stopTimer();
    void (async () => {
      let result: RunResult;
      try {
        result = await opts.run(next);
      } catch (e) {
        result = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      } finally {
        inFlight = false;
      }
      if (result.ok) {
        if (armed === next) release();
        opts.notify("Handoff complete: the work continues in a fresh session.", "info");
        opts.onDone?.(next);
        return;
      }
      if (armed === next) release();
      if (result.cancelled) {
        opts.notify(
          "Handoff session swap was cancelled by another extension. The summary is " +
            "saved; run /datcrazy-handoff resume or /new to continue it.",
          "warning",
        );
      } else {
        opts.notify(
          `Handoff swap failed (${result.reason ?? "unknown reason"}). The summary is ` +
            "saved; the continuation resumes in the next session in this folder or " +
            "via /datcrazy-handoff resume.",
          "error",
        );
      }
      opts.onFail?.(next, result.cancelled ? "cancelled" : (result.reason ?? "failed"));
    })();
  };

  return {
    arm(next: ArmedHandoff): void {
      if (disposed) return;
      armed = next;
      armedAt = now();
      startTimer();
    },
    kick(): void {
      tick();
    },
    cancel(): boolean {
      const was = armed !== null;
      release();
      return was;
    },
    status() {
      return {
        armed: armed !== null,
        kind: armed?.kind ?? null,
        inFlight,
        waitingMs: armed ? now() - armedAt : 0,
      };
    },
    dispose(): void {
      disposed = true;
      armed = null;
      stopTimer();
    },
  };
}
