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
   `/new`, or a restart still resumes the work. A failed or cancelled swap
   re-writes the seed; a delivered one consumes it.

Folder identity is canonicalized (realpath, slash style, case on Windows), so a
handoff written at `C:/x/proj` is found by a session booting in `C:\x\proj`.

## When it cannot swap in place

- **`pi -p` / `--print`** — no session to continue; the seed waits for the next
  interactive session in that folder.
- **No command dispatch** (a host that does not run extension commands from
  user messages) — the tool reports `no-command-ctx` and the seed is still
  durable: `/datcrazy-handoff resume` or `/new` resumes it.

## Interop

The extension publishes its runtime on
`globalThis[Symbol.for("datcrazy-handoff.runtime.v1")]`:

```ts
const runtime = globalThis[Symbol.for("datcrazy-handoff.runtime.v1")];
const status = await runtime.armSwap(continuation, { cwd, parentSession, artifactPath, notify });
// "armed" | "no-command-ctx" | "unsupported"
```

`datcrazy-remote` uses this: when this addon is installed, its `datcrazy_handoff`
tool delegates the swap here instead of relying on a captured command context.

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
  seeds/seed-<slug>-<hash>.json         # per-folder, one-shot continuation
```

## License

MIT — built by datcrazy (<https://pi.datcrazy.co>).
