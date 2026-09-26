# Changelog

All notable changes to OpenFlow are recorded here. OpenFlow lives in `packages/flow`;
the rest of the repo is a vendored OpenCode fork and is not covered by this file.

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
