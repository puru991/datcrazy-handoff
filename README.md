# datcrazy-handoff

**Part of the datcrazy Pi stack — <https://pi.datcrazy.co>.**

Autonomous, durable **session handoff** for the [Pi coding agent](https://pi.dev).

Summarize the work, swap to a fresh session, and keep going — without a human
pressing `/new`. If the swap cannot happen right now, the continuation is
already on disk: the next session in that folder resumes it automatically.

- **Tool:** `handoff`
- **Command:** `/datcrazy-handoff status | list | resume | cancel`
- **Storage:** `~/.pi/datcrazy/handoff/` (artifacts + per-folder seeds)

## Install

Source: <https://github.com/puru991/datcrazy-handoff> (MIT).

```bash
pi install npm:datcrazy-handoff
# or from a checkout:
pi install /absolute/path/to/packages/datcrazy-handoff
```

Try it without installing:

```bash
pi -e ./packages/datcrazy-handoff
```

## Use

Ask the agent:

> Summarize where we are and hand off to a fresh session.

It calls `handoff` with a `summary` (plus optional `goal`, `artifacts`,
`openQuestions`, `root`). The tool writes the artifact, writes a continuation
seed, and arms the swap. When the current turn settles, a fresh session starts
and its first user message is the continuation prompt.

From the keyboard:

| Command | What it does |
|---|---|
| `/datcrazy-handoff status` | Pending swap, seed, last artifact |
| `/datcrazy-handoff list` | Recent handoff artifacts for this folder |
| `/datcrazy-handoff resume [--path <artifact.json>]` | Arm a swap now from the pending seed or a named artifact |
| `/datcrazy-handoff cancel` | Drop the pending swap and clear the seed |

## How it works (and why)

Three Pi constraints shape the design; each one is covered by a test.

1. **A tool handler cannot create a session.** `newSession` exists only on
   `ExtensionCommandContext` (command handlers), because calling it from an
   event handler can deadlock. Most extensions capture a command context when
   the user happens to run one of their slash commands — which is exactly why
   "handoff" implementations silently do nothing in sessions where no such
   command was ever typed. `datcrazy-handoff` instead *dispatches its own
   command*:

   ```ts
   await pi.sendUserMessage("/datcrazy-handoff __arm <token>", { expandPromptTemplates: true });
   ```

   Pi runs extension commands immediately, even mid-turn, with a real command
   context. The token acknowledges that the context was captured.

2. **The swap must not run inside the live turn.** `ctx.newSession()` tears the
   session down (`abort()` → `waitForIdle()`), so calling it from a tool body or
   an `agent_end` handler deadlocks against the run that is calling it. The
   controller waits for an idle tick (`agent_settled` plus a short poll) and
   only then replaces the session.

3. **A handoff must survive everything.** The artifact and the per-folder seed
   are written *before* any swap attempt, so a crash, a killed process, a native
   `/new`, or a restart still resumes the work. Seeds publish through unique
   temporary-file-plus-rename generations. A delivered or explicitly cancelled
   generation is atomically renamed to its own `.consumed` marker; callbacks
   never unlink or rewrite a newer generation. Failed swaps leave the original
   generation in place for retry. When the process cannot
   replace its own session, a successor process continues the work instead — see
   below.

Folder identity is canonicalized (realpath, slash style, case on Windows), so a
handoff written at `C:/x/proj` is found by a session booting in `C:\x\proj`.

The active provider/model and effective thinking level are captured from Pi's
runtime (not tool arguments). Fresh in-process sessions restore that selection
before the continuation prompt; detached successors and durable restart seeds
carry the same metadata. Older artifacts and seeds without metadata remain
readable and continue with normal Pi selection.

## When it cannot swap in place

A handoff never dead-ends. In order of preference:

1. **Fresh session in this process** — the normal path: a real command context is
   acquired, and the session is replaced when the turn settles.
2. **Successor process** — when there is no live session to replace (`pi -p`,
   `--mode text|json`) or the host does not dispatch extension commands from user
   messages, a detached `pi --print` process is started in the same folder with the
   continuation on its stdin. It inherits your provider, model, thinking level,
   extension/skill/tool flags and session dir; it does not inherit the parent's
   session, name, prompt or API keys. Output lands in
   `~/.pi/datcrazy/handoff/logs/successor-<utc>.log`; a generation counter stops a
   chain at 25 restarts.
3. **Durable seed** — if no successor can be started either (an embedded host with
   no `pi` entry point), the continuation waits on disk: `/datcrazy-handoff resume`
   or the next session in that folder picks it up.

## Interop

The extension publishes its runtime on
`globalThis[Symbol.for("datcrazy-handoff.runtime.v1")]`:

```ts
const runtime = globalThis[Symbol.for("datcrazy-handoff.runtime.v1")];
const status = await runtime.armSwap(continuation, {
  cwd,
  parentSession,
  artifactPath,
  // Optional explicit state captured by the caller; omitted means the addon
  // captures the live provider/model/thinking state itself.
  runtime: { provider, model, thinking },
  notify,
});
// "armed" | "no-command-ctx" | "unsupported"
```

`datcrazy-remote` uses this: when this addon is installed, its `datcrazy_handoff`
tool delegates the swap here instead of relying on a captured command context.
The addon owns the artifact/seed and successor handoff. With no explicit
`runtime`, `armSwap` captures the live extension context; explicit state is
used when supplied. New handoffs without either live or explicit runtime are
rejected, while older metadata-free seeds remain resumable with Pi's legacy
selection behavior. Persisted runtime state always wins over launch flags.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATCRAZY_HANDOFF_HOME` | user home | Root for `~/.pi/datcrazy/handoff/` |
| `DATCRAZY_HANDOFF_TICK_MS` | `250` | Idle poll interval while a swap is armed |
| `DATCRAZY_HANDOFF_SWAP_TIMEOUT_MS` | `300000` | How long an armed swap waits for an idle session |

## Development

```bash
npm test        # node --test, no build step (Node >= 20, TS loaded directly)
npm run typecheck
```

Storage layout:

```
~/.pi/datcrazy/handoff/
  artifacts/<utc>-<slug>/handoff.json   # schema 1: summary, goal, artifacts, questions, continuation prompt
  seeds/seed-<slug>-<hash>-<generation>.json  # immutable continuation generation
  seeds/*.json.consumed                       # exact-generation consume markers
  seeds/seed-<slug>-<hash>.json               # legacy metadata-free compatibility
  logs/successor-<utc>.log                    # output of successor processes
```

## License

MIT — built by datcrazy (<https://pi.datcrazy.co>).
