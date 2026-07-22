---
name: plan-implement
description: >-
  Orchestrated end-to-end workflow that takes a non-trivial task from idea to committed code.
  An Opus subagent plans, the user answers the plan's open questions, a Sonnet subagent implements,
  a Sonnet subagent verifies (tests / lint / typecheck), the fix→verify loop repeats until green,
  and it commits only after the user approves. Use this whenever the user wants a feature, refactor,
  or bugfix carried through planning and verification rather than implemented ad hoc — e.g.
  "zaplanuj i zaimplementuj X", "weź to zadanie od planu do commita", "zbuduj funkcję Y z weryfikacją",
  "plan and implement", "implement this properly with a verification pass". Prefer this skill over
  jumping straight to edits whenever a task is big enough to deserve a written plan and an independent check.
---

# Plan → Implement → Verify → Commit

This skill orchestrates a task through five stages using **model-specialised subagents**: Opus plans
(thinking-heavy, read-only), Sonnet implements and verifies (execution-heavy). You stay the
**orchestrator** — your job is to spawn subagents, carry state between them, talk to the user, and drive
the fix loop. **Do not implement the task yourself**; that defection is the most common way this workflow
degrades into a normal ad-hoc edit session.

Communicate with the user in Polish (their preference). Subagent prompts can be in English.

## Roles at a glance

| Stage | Who | `subagent_type` | `model` | Can edit files? |
|-------|-----|-----------------|---------|-----------------|
| 1. Plan | Opus architect | `Plan` | `opus` | No (read-only) |
| 3. Implement | Sonnet builder | `general-purpose` | `sonnet` | Yes |
| 4. Verify | Sonnet reviewer | `general-purpose` | `sonnet` | No — report only |

Set `model` explicitly on every `Agent` call — it overrides the agent definition and is what pins each
stage to the right tier. Subagents **do not share context with each other or with you**, so every stage's
inputs must be passed in the prompt. Carry the plan in a **file** (see below), not by retyping it.

---

## Stage 0 — Frame the task

Restate the task in one or two sentences and confirm you understand the goal before spending Opus tokens on
planning. If the request is a vague one-liner, ask the user what "done" looks like first — a fuzzy goal
produces a fuzzy plan and wastes the whole pipeline.

Pick a short working slug for the task (e.g. `add-token-revoke`). You'll reuse it for the plan file and
subagent labels.

---

## Stage 1 — Plan (Opus, read-only)

Spawn one planning subagent:

- `subagent_type: "Plan"`, `model: "opus"`, label like `plan:<slug>`.
- The `Plan` agent is read-only by design — it produces a plan without touching code, which is exactly what
  you want here.

Prompt it to return, in this order:

1. **Approach** — the strategy and why, plus rejected alternatives if the choice is non-obvious.
2. **Concrete steps** — an ordered, file-by-file change list (paths, functions, new files) precise enough
   that a builder who has never seen this conversation could follow it.
3. **Risks / touch-points** — migrations, shared modules, backwards-compat, security-sensitive spots.
4. **Verification criteria** — how success will be checked (which tests, which command paths, which
   end-to-end flow to exercise).
5. **Open questions** — every ambiguity or decision that needs the user. If there are none, say so
   explicitly.

Tell it to read `CLAUDE.md` and relevant existing code so the plan matches repo conventions.

When it returns, **write the plan to a working file** in your scratchpad directory (its absolute path is in
your environment), e.g. `<scratchpad>/plan-<slug>.md`. This file is the single source of truth passed to
later stages.

---

## Stage 2 — Open questions & plan lock-in

This is the human gate. Present the plan's **open questions** to the user:

- For questions with a small set of discrete answers, use `AskUserQuestion` (batch up to 4 at once).
- For genuinely open-ended ones, ask in plain text.

Fold the answers back into the plan file. If an answer materially changes the approach, re-spawn the Opus
planner with the answers to revise (cheaper than letting a wrong plan propagate downstream); for minor
clarifications, edit the plan file directly.

Then show the user the **final plan** and get an explicit go-ahead before implementing. Respect the user's
standing preference: larger changes get a short plan accepted before any files are edited. Do not proceed to
Stage 3 without that yes.

---

## Stage 3 — Implement (Sonnet)

Spawn one implementation subagent:

- `subagent_type: "general-purpose"`, `model: "sonnet"`, label like `impl:<slug>`.
- In the prompt: give the **absolute path to the plan file** and instruct it to read that file plus
  `CLAUDE.md`, implement the plan faithfully, match surrounding code style, and **not** commit or push.
- Ask it to return a concise **change report**: files touched, notable decisions, anything it deviated from
  in the plan and why, and anything it couldn't complete.

If the task is large, it's fine to let one builder do the whole plan — keep it a single agent so the changes
stay coherent, rather than splitting one plan across parallel editors that would conflict.

---

## Stage 4 — Verify (Sonnet, read-only)

Spawn one verification subagent:

- `subagent_type: "general-purpose"`, `model: "sonnet"`, label like `verify:<slug>`.
- Open the prompt with: **"You are a read-only verifier. Do not modify any files. Run the checks and report
  findings only."** Keeping fix and verify in separate agents is deliberate — a reviewer who can't edit
  can't paper over a defect it should be reporting.
- Give it the plan file path and the builder's change report, and tell it to:
  1. Run the project's checks and report the **actual** output (not an assumption they pass). For this repo:
     - Tests: `pnpm -r test`
     - Lint: `pnpm lint`
     - Typecheck: this repo has no dedicated script — run `tsc --noEmit` per package (build via `nest build`
       is the fallback proxy).
     - First confirm these against `package.json`, since scripts can change.
  2. Check the diff against the plan's **verification criteria** and against the plan itself — was everything
     implemented, and correctly?
  3. Where feasible, exercise the changed path end-to-end, not just unit tests (matches the user's standing
     preference for real end-to-end verification).
- Require a structured verdict: **`PASS`**, or **`FAIL`** with a numbered list of concrete, reproducible
  defects (file, symptom, failing command / expected-vs-actual). Vague "looks risky" notes are not defects.

---

## Stage 5 — Fix loop

If the verdict is `FAIL`:

1. Spawn a **fresh** implementation subagent (`general-purpose`, `sonnet`) with the plan file path, the prior
   change report, and the verifier's numbered defect list. Instruct it to fix exactly those defects.
2. Re-run Stage 4 verification.
3. Repeat until `PASS` or until **3 fix→verify rounds** have passed.

If it still fails after 3 rounds, stop looping and hand the outstanding defects to the user with a short
diagnosis — burning more rounds usually means the plan itself is wrong, which is a decision for the user, not
another retry.

Keep the user informed between rounds (one line: what failed, what's being fixed).

---

## Stage 6 — Commit

Once verification passes:

1. Summarise for the user what was built and the final verification result (real command output).
2. **Ask** whether to commit, and propose a commit message. Commit only on an explicit yes — never commit or
   push unprompted.
3. On approval, commit to the current branch (this repo works on `main` directly; only branch if the user
   asks). End the commit message with the required trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
4. Do **not** push unless the user explicitly asks.

---

## Notes & pitfalls

- **Context isolation is the whole reason for the plan file.** If a subagent seems to "forget" the task, the
  cause is almost always missing context in its prompt — pass the plan file path and the relevant prior
  report every time.
- **Don't skip the human gate (Stage 2).** Silently guessing answers to open questions is how the wrong thing
  gets built well.
- **Keep the tiers right.** Opus for planning is worth it; downgrading the planner to save tokens is a false
  economy because a bad plan costs far more downstream. Sonnet is the right tier for implement/verify.
- **You orchestrate, you don't build.** If you find yourself editing source files directly, you've dropped
  out of the workflow — delegate it to a Stage 3 subagent instead.
- If a stage's subagent returns `null` (skipped or died), don't fabricate its result — tell the user and
  decide whether to re-spawn.
