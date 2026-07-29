---
name: roadmap-reconcile
description: >-
  Reconcile a project roadmap with what the repo actually shows: mark finished items done, keep
  unfinished ones honest, pull in work that happened off-plan, and sync the backlog. When a
  milestone closes, archive a dated snapshot of the roadmap before rewriting the living one.
  Use whenever the user wants the roadmap refreshed, verified, closed out, or restarted for a new
  version — e.g. "zaktualizuj roadmapę", "domknij v1.3 i zrób nową", "co z roadmapy jest już
  zrobione", "reconcile the roadmap", "przejrzyj roadmapę i backlog".
---

# Roadmap reconcile

Bring the roadmap back in line with reality. **Evidence first, edits second** — every status change
must come from the repo (code, tests, git log), never from what the roadmap already claims or what a
subagent asserts. Talk to the user in Polish; file contents follow the language already used in them.

## 1. Locate the documents

Glob for the roadmap (`**/roadmap*.md`, `**/ROADMAP*.md`), the backlog (`**/backlog*.md`), and the
archive directory (sibling `archive/` of the roadmap). In this repo: [`context/roadmap.md`](../../../context/roadmap.md),
[`context/backlog.md`](../../../context/backlog.md), `context/archive/`. If several candidates match, ask which one is the
living roadmap. Read all of them plus the previous archive snapshot's header (it defines the naming
and cross-link convention to follow).

## 2. Gather evidence

Read the roadmap's `Aktualizacja:` date (or last archive snapshot) as the reconcile window start.
Then, for every item that is **not** already marked done:

- `git log --since=<date> --oneline` and the merge commits / PR titles in that window.
- Grep for the concrete artifact the item promises (endpoint, table, screen, flag, CLI, migration) —
  a commit message is a hint, the code is the proof.
- Note work in the window that maps to **no** roadmap item — off-plan work is a real finding.

Verify each claim in the source before writing it down; do not trust a line just because a report or
commit message says so.

## 3. Classify and confirm with the user

Produce a short reconcile table before touching any file:

| Item | Roadmap says | Evidence | Proposed |
|---|---|---|---|
| … | ⬜ | `apps/server/src/…` + migration `…` | ✅ |

Buckets: **done** (shipped and verifiable) · **in progress** (partial — say what is missing) ·
**not started** · **off-plan** (happened, needs a roadmap line) · **stale** (planned but no longer
makes sense → propose move to backlog or explicit cut). Ask the user to confirm; only ambiguous or
judgment calls need a question, obvious ones just get reported.

## 4. Archive — only when a milestone closes

Archive when the roadmap is being **restarted** for a new version/phase, not on an ordinary refresh.
Before rewriting:

1. Copy the current roadmap verbatim to `archive/roadmap-<YYYY-MM-DD>-<milestone>-complete.md`
   (date = today, `<milestone>` = the version being closed, e.g. `v1.2`).
2. Prepend a blockquote header matching the previous snapshots: what state it froze, why, a link back
   to the living roadmap, and a link to the previous snapshot.
3. In the living roadmap, replace the finished phase's full descriptions with **one-line summaries**
   and point to the new snapshot; keep the chain of "previous snapshot" links intact.

Never delete roadmap history — it moves to `archive/`, it does not disappear.

## 5. Rewrite the living roadmap

- Update the `Aktualizacja:` date and the `Etap:` line (what closed → what we enter).
- Apply the confirmed statuses using the file's own legend (✅ / 🔨 / ⬜ / ⏸️).
- Done items keep a **short** description of what actually shipped, including deviations from plan;
  in-progress items state what is left.
- Add off-plan work as proper items. Move stale items to the backlog with a one-line "why deferred",
  or to a "Wycięte" section with the reasoning when they are dropped for good.
- Keep the living roadmap thin: current milestone in detail, everything earlier as one-liners.

## 6. Sync the backlog

Mirror the moves in both directions: items promoted backlog → roadmap disappear from the backlog and
are listed in its `Aktualizacja:` note; items demoted roadmap → backlog arrive with their reason and
condition for coming back. Update the backlog's date line and cross-links so the two files never
disagree about where an item lives.

## 7. Report

Summarise for the user: what changed status (with the evidence), what was archived and where, what
moved between roadmap and backlog, and anything you could not settle. Do not commit unless asked.
If a non-obvious convention or decision came out of the reconcile (e.g. why something was cut),
propose saving it via `save_memory`.
