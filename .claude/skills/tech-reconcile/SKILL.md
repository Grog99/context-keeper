---
name: tech-reconcile
description: >-
  Review what the architecture has become, not what the last diff changed: structural growth since
  the previous review — modules that swelled feature after feature, hand-rolled code an installed
  dependency already covers, `tech-stack.md` drifting from the code, new surfaces without
  rate-limit or audit, queries without an index. Every finding starts from a symptom in the repo
  with `file:line` evidence; accepted ones land in the backlog, implementation goes through
  `plan-implement`. Use whenever the user wants a technical/architectural stock-take — e.g.
  "przejrzyj architekturę", "co w kodzie się rozjechało", "czy warto tu dodać bibliotekę",
  "jaki dług techniczny narósł", "tech reconcile", "review the architecture", "what technical debt
  piled up". This is a state review over a time window — not a review of the current diff
  (`/code-review`, `simplify`) and not a review of scope (`roadmap-reconcile`).
---

# Tech reconcile

Look at what the architecture has become since the last review. **Symptom first, recommendation
second** — every finding starts from an observable symptom in the repo, cited as `file:line`. A
recommendation with no symptom behind it is not a finding, it is noise, and it does not get
reported. Not one "worth considering X, it is popular these days". Talk to the user in Polish; file
contents follow the language already used in them.

You do not implement anything here. This skill ends with an agreed list and backlog entries.

## 1. Locate the documents and the window

Read [`context/tech-review.md`](../../../context/tech-review.md) — its `**Aktualizacja:**` header is
the start of the review window. **No such file → first run:** the window is the whole history; say
so explicitly in the file you generate.

Read the surrounding canon: [`context/tech-stack.md`](../../../context/tech-stack.md) (architecture
of record — numbered sections `§0`–`§15`, other documents cross-reference them as `§N`),
[`context/backlog.md`](../../../context/backlog.md), [`context/roadmap.md`](../../../context/roadmap.md).

Then build the **exclusion list** — this is the step that keeps the skill from repeating itself. It
has three sources:

- `## Odrzucone` in `tech-review.md` — considered and consciously refused.
- `## Wycięte` in `backlog.md` — dropped for good, with the reasoning (e.g. Memory Worth, 2026-07-27).
- **Every open backlog item** — a topic already planned is not a finding.

The third source matters most in practice: a Redis-backed rate-limiter is already sitting in
`backlog.md` under "Skalowanie / interop", so reporting it would be a false positive, not insight.

## 2. Frame the window

- `git log --since=<date> --oneline` and `git diff --stat <since>..HEAD` — what actually grew, and where.
- That file list is the input for the agents in the next step. The review centres on what changed,
  but going outside the window is allowed when a change exposed a problem in older code.

## 3. Fan out — six lenses, three read-only agents

Launch three `Explore` agents in parallel (one message, three calls):

| Label                 | Lenses                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tech:docs+structure` | **Doc drift**: `tech-stack.md` §1–§15 vs the actual code (data model, retrieval pipeline, modules, env). · **Structure**: modules that swelled, duplication, leaking layers, repeated boilerplate that wants an abstraction                                            |
| `tech:deps+tests`     | **Dependencies**: installed but unused; hand-rolled code an existing dependency already covers; `pnpm outdated`, `pnpm audit`. · **Tests**: critical paths with no coverage — note that `apps/dashboard` has no `test` script, so `pnpm -r test` is really server-only |
| `tech:data+ops`       | **Data / performance**: schema and indexes vs the queries actually issued, N+1, retrieval cost. · **Ops / security**: new HTTP or MCP surfaces without rate-limit, audit or logging; secrets; config                                                                   |

Every agent prompt must carry:

- The window dates, the changed-file list, and the **exclusion list** from step 1.
- The finding contract: `symptom` + `evidence file:line` + `why it hurts` + `proposal` + `rough cost`
  (S/M/L). **No evidence → do not report it.**
- "Zero findings" is a correct answer. Do not fill a quota.
- Read-only: do not edit any file.

## 4. Verify before you report

[`AGENTS.md`](../../../AGENTS.md) says it outright: verify a subagent's `file:line` in the source
before using it — subagents get line numbers wrong. **Read every cited piece of evidence.** A
finding whose evidence does not hold up is dropped, or gets its location corrected.

Only here may you use **WebSearch**, and only pointed at a symptom you have already confirmed: "we
have N lines of hand-rolled X, is there a library for that", or "is dependency Y deprecated". Record
what you checked in the finding. Never the other way round — the network does not generate topics.

## 5. Confirm with the user

Produce the table before touching any file:

| #   | Objaw (dowód)             | Wymiar    | Waga | Propozycja | Koszt |
| --- | ------------------------- | --------- | ---- | ---------- | ----- |
| 1   | … `apps/server/src/…:120` | struktura | 🔴   | …          | S/M/L |

Weight: 🔴 hurts now · 🟠 will hurt at the next feature · 🟢 cosmetic.

The user decides per row: **accept** (→ backlog/roadmap) · **reject** (→ `Odrzucone`, with the
reasoning) · **do it now** (→ hand off to `plan-implement`). Batch discrete-choice questions via
`AskUserQuestion` (up to 4 at once); ask genuinely open-ended ones in plain text.

## 6. Write the living document

The structure lives in [`tech-review-template.md`](tech-review-template.md) — read it before writing
and follow it exactly; its leading HTML comment carries the per-field filling rules and does not go
into the output file. The shape in short:

- **Otwarte** — a scan table (`# · Ustalenie · Wymiar · Waga · Koszt`, one line each, no reasoning)
  followed by one block per finding. Each block is a five-row table: **Objaw** (what is visible, no
  interpretation) · **Dowód** (`file:line`, the ones you verified in step 4) · **Powoduje** (who,
  on what input, loses what) · **Fix** (one sentence) · **Koszt**. Row numbers match block numbers.
- **Zrobione** and **Odrzucone** — plain tables, no blocks.

Keep cells to a single line. If **Powoduje** will not fit in one compound sentence, that finding is
really two — split it. Never merge **Objaw** and **Powoduje** into one prose paragraph; the split
between "what is visible" and "what it costs" is what makes the file skimmable a month later.

`## Odrzucone` mirrors `## Wycięte` in the backlog, and it is the reason the second and third run do
not repeat the first. Keep the file thin: open findings in full, finished ones as table rows.

## 7. Archive — only when the file gets heavy

Not every run. Archive when a version is being closed, or when `## Zrobione` has outgrown one-liners:

1. Copy the current file verbatim to `context/archive/tech-review-<YYYY-MM-DD>.md`.
2. Prepend a blockquote header in the convention of the existing snapshots: what state it froze, why,
   a link back to the living file, and a link to the previous snapshot.
3. In the living file, keep the chain of "previous snapshot" links intact.

History does not get deleted — it moves.

## 8. Sync the backlog and report

Accepted findings go into [`context/backlog.md`](../../../context/backlog.md) under a
`## Dług techniczny / architektura` section, in that file's item format (`- **Nazwa** ⬜ — opis`),
linking back to `tech-review.md`. Update the backlog's `**Aktualizacja:**` line.

Summarise for the user: how many findings, what was accepted or rejected, what could not be settled,
and what fell out during evidence verification — say that out loud, a dropped finding is a real
result. Hand "do it now" items to `plan-implement`; the split of roles is deliberate. Do not commit
unless asked. If a non-obvious decision came out of the review (e.g. why something is consciously not
worth doing), propose saving it via `save_memory`.
