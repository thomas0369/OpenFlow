# Changelog

All notable changes to OpenFlow are recorded here. OpenFlow lives in `packages/flow`;
the rest of the repo is a vendored OpenCode fork and is not covered by this file.

## [1.5.1] - 2026-09-26

Dauerbetrieb: the loop that keeps the factory at 10/10 without anyone watching.

- **of-loop.ts / `of-run.sh --loop`** — self-healing cycle: reap zombies → find
  healable error runs (pipeline allowlist, finished within 24 h, never resumed
  before, own auto-retry not spent, checkpoint present and quiet) → relaunch
  each via checkpoint-resume (detached, AUTO_RETRY on) → one state line in
  `/tmp/of-loop-state.jsonl`. Every healing chain runs at most once per run
  (`loop.resumedAt` mark, atomic write) — nothing chains forever.
- **Verankert als cron-Job** (`*/5 * * * *`, alongside the established
  dharma-watch cadence; systemd --user has no bus on this host) — a cycle
  proved itself in an empty environment (`env -i`).
- **of-run.sh fixes the documented resume call** — `--resume <id>` without a
  pipeline word died on `set -u` unbound `$1` since the flag existed; the
  runner now defaults the log name to "resume" (headless-run overwrites it
  from the checkpoint). Also: `bun` resolved via `command -v` with hard
  fallback to `~/.local/bin/bun` — cron PATHs do not carry it.

## [1.5.0] - 2026-09-26

Closes the three gaps measured in the 26.09.2026 rating (automation 3/10,
verdicts unmeasured): the factory now reaps its dead, retries its failures,
measures every run, and the routing rule is enforced by a gate instead of
agent discipline.

- **of-reap.ts / `of-run.sh --reap`** — zombie reaper. A run whose headless
  process died stayed "running" forever (8 measured in flow-lab). Criterion,
  provable without PID files: the runner rewrites the checkpoint on every
  patch, so a checkpoint silent for 15+ minutes (or missing past a grace
  window) means the process is gone. Reap = honest stop: status "stopped",
  reason, `reaped` block, atomic temp+rename write. Every `of-run.sh` start
  reaps first.
- **Auto-Retry** (headless-run.ts) — a run ending in error re-launches itself
  once through checkpoint-resume: done cards keep their output at no cost, the
  card that broke the run retries in its session. Proof case 20.09.2026: two
  clean worker reports, one node error, four cards skipped, nobody restarted.
  `OPENFLOW_AUTO_RETRY` (default 1, `0` disables).
- **Scorecard** (of-scorecard.ts / `of-run.sh --scorecard`) — a measurable
  verdict per run (PASS, PASS_RETRIED, FAIL, STOPPED) from node counts,
  duration, output words and attempts; written into the run log, printed as a
  `=== SCORECARD ===` block on stdout, aggregated over all runs with a
  discipline section from the gate ledger.
- **of-gate.ts** — deterministic REGEL-4 classifier (no LLM): Ja-Fall/Nein-Fall
  signal lists from the 18.09.2026 order, safety beats efficiency, `fabrik:` /
  `direkt:` prefixes override. `of-gate.ts log` appends to
  `~/.openflow/gate-ledger.jsonl`.
- **fabrik-gate plugin** (opencode, ~/.config/opencode/plugins) — injects the
  gate verdict into every `task` call (FABRIK → duty path block, GRAUZONE →
  justification hint) and logs task verdicts and real `of-run.sh` invocations
  to the ledger. Fail-open: a broken gate never blocks work.

## [1.4.1] - 2026-09-26

- Corrects 1.4.0's "empty confine" finding: there is no confine. A card on
  `dharma/brain` narrates tool results its provider serviced remotely (`Error:
  File not found` for a file that exists, `/agent` as cwd, no `tool` parts, no
  events); the same task on `deepseek/deepseek-flash` leaves a real `read`
  tool part in the session and returns the file's content. Agent-tier models
  are safe for text orchestration only — FLOW.md carries the rule with both
  measurements.

## [1.4.0] - 2026-09-26

- A card's session is named `role (id)` in the sidebar, best effort, through the root-group
  session PATCH — and the dev proxy carries `/session` so the call survives the SPA fallback.
- Contract skills read **global before project**: `GET /flow/api/skill-source/:name` reads
  `~/.config/opencode/skills` first (honouring `XDG_CONFIG_HOME`), and `skill-source` lists
  both stores merged — the list a refine briefing offers.
- Measured and documented: in this vendored stand a card's tools run in an empty `/agent`
  confine that mounts neither project nor host — file work from a card cannot run until the
  upstream runtime changes; text orchestration and engine-side evidence are unaffected.

## [1.3.0] - 2026-09-26

- Orchestration can run on contracts. A `refine` canvas refuses an orchestrator's
  first dispatch until it carries a `plan` with `verify` criteria; the criteria
  reach every critic, every result turn and the team board (one `[T0]` line).
- Assignments may carry `evidence` (measured facts ahead of the task, budgeted),
  `skills` (folders from `.openflow/skills`, read by the engine and ridden on the
  card's first turn only) and `avoid` (fenced paths; writes are reported after the
  batch, and a fence another card declares written is refused before it runs).
- New template: **dirigent build** — a cheap briefing card writes the contract,
  a boss runs it.
- Everything is off unless the canvas asks; a canvas that has never set `refine`
  dispatches exactly as it always did.

## [1.2.1] - 2026-09-01

- Keep swarm and orchestration cards out of each other's files: a batch is refused
  before it runs when two assignments declare the same path, and a post-batch
  collision report tells the orchestrator when cards wrote over each other.
- Warn about swarm peers with nothing to disagree about, and about peers that can
  write files.
- Pick up a run the browser tab abandoned instead of starting it over.
- Gauntlet: survive rate limits, count what they cost, and refuse to certify
  unjudged work.

## [1.2.0] - 2026-08-29

- Run a canvas as a swarm: parallel peers debate over rounds, and a synthesizer
  card writes the verdict.
- Run a canvas as an orchestration: an orchestrator dispatches work to child cards,
  recursively, bounded by the tree you draw.

## [1.1.2] - 2026-08-29

- Brief every card on the pipeline it runs in.
- Repackage OpenAI-compatible providers from the panel.

## [1.1.1] - 2026-08-24

- Maintenance release.

## [1.1.0] - 2026-08-21

- Run flow's CI checks on GitHub-hosted runners.

## [1.0.0] - 2026-08-17

- First release.

[1.2.1]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.1
[1.2.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.0
[1.1.2]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.2
[1.1.1]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.1
[1.1.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.0
[1.0.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.0.0
