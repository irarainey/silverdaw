---
description: "Markdown and documentation conventions for Silverdaw — file shape, the durable context files, ADRs, and CHANGELOG entries"
applyTo: "**/*.md"
---

# Markdown & Documentation — Silverdaw

Documentation here is a durable engineering asset, not decoration. It is read by
the next contributor and by AI assistants working from a finite context window,
so the cost of a document is real: stale or bloated prose is worse than none.

## Document only what exists

Every statement must be traceable to something actually in the repository —
real functions, parameters, behaviours, paths, and commands. Do not describe
planned, inferred, or aspirational behaviour unless the document explicitly
covers unreleased work (`docs/development-plan.md`). Where the code is
ambiguous, document what is certain and say the rest is unclear rather than
filling the gap. When you change a document, verify any command, path, or link
you touched.

## File shape

- One `#` H1 title per file, then content under `##` / `###`. `####` and deeper
  usually means the section wants splitting.
- **No YAML front matter** in project documentation. Front matter appears only
  in `.github/` tooling files: `description` + `applyTo` for
  `*.instructions.md`, `mode` + `description` for `*.prompt.md`, `name` +
  `description` for agents.
- Wrap prose at roughly 80 columns. Tables, links, and code may overflow —
  never reflow them to hit a column count.
- Fenced code blocks carry a language identifier; `text` for diagrams and
  console output.
- LF endings and a trailing newline (`.editorconfig`). There is no markdownlint
  configuration — these conventions are the standard.

## The durable context files

`CONTEXT.md` is the small, always-on core; `ARCHITECTURE.md`, `DECISIONS.md`,
and the deeper guides are opened only when a task touches them. Protect that
split when editing them:

- **Link, don't inline.** Detail belongs in the linked document. Adding
  reference material to `CONTEXT.md` or `ARCHITECTURE.md` costs every future
  session tokens whether or not it is relevant.
- Tag durable constraints `CRITICAL`, `IMPORTANT`, or `REFERENCE` — the tag
  doubles as a load level, so only `CRITICAL` material earns a place inline in
  the core.
- `CONTEXT.md` and `ARCHITECTURE.md` carry a `_Last reviewed: YYYY-MM-DD ·
  Owner: @handle_` line. Update the date when you revise them.
- Prefer pointing at the most faithful source — code, a zod schema, a test —
  over paraphrasing it. Prose carries intent, constraints, and rejected
  alternatives, which code cannot.

## ADRs

One decision per file at `docs/adr/NNNN-kebab-slug.md`, written at the moment of
decision:

```text
# ADR NNNN — Short decision statement

- **Date:** YYYY-MM-DD · **Status:** Accepted · **Owner:** @handle · **Importance:** `CRITICAL`

## Decision
## Why
## Rejected alternatives
```

`Rejected alternatives` is the section that earns the ADR its keep — it is the
reasoning that compaction and time destroy first. Add the matching one-line row
to `DECISIONS.md` in the same change.

## CHANGELOG entries

`CHANGELOG.md` is a **repo-level** log read from a developer's perspective: it
records every key change to the codebase, not only the ones a user would notice.
Engineering-only work — a new test tier, a build or tooling change, a
dependency swap — earns an entry when it is a key change in its own right.

- One short, high-level sentence per entry describing **what changed** — not its
  cause, mechanism, or implementation.
- Lead with the observable effect. For user-facing work that is the behaviour a
  user sees; for engineering-only work it is the capability the repository gains.
- No trailing explanations, parentheticals, em-dash clauses, or "because…"
  detail. If a reader needs the why, it belongs in a code comment, `docs/`, or
  an ADR.
- One bullet per change, grouped under `Added` / `Changed` / `Fixed`.
