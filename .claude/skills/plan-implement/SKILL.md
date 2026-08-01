---
name: plan-implement
description: >-
  Orchestrated end-to-end workflow that takes a non-trivial task from idea to committed code.
  An Opus subagent plans, the user answers the plan's open questions, a Sonnet subagent implements,
  then verification runs `pnpm verify` plus an independent code review by the Codex CLI
  (`codex exec`), the fix→verify loop repeats until green,
  and it commits only after the user approves. Use this whenever the user wants a feature, refactor,
  or bugfix carried through planning and verification rather than implemented ad hoc — e.g.
  "zaplanuj i zaimplementuj X", "weź to zadanie od planu do commita", "zbuduj funkcję Y z weryfikacją",
  "plan and implement", "implement this properly with a verification pass". Prefer this skill over
  jumping straight to edits whenever a task is big enough to deserve a written plan and an independent check.
---

# Plan → Implement → Verify → Commit

This skill orchestrates a task through several stages using **model-specialised subagents**: Opus plans
(thinking-heavy, read-only), Sonnet implements (execution-heavy). Verification is deliberately **not** a
Claude subagent — it is `pnpm verify` plus the **Codex CLI** reviewing the diff, so the code is judged by a
model outside the family that wrote it. You stay the **orchestrator** — your job is to spawn subagents, run
the verification pass, carry state between stages, talk to the user, and drive the fix loop. **Do not
implement the task yourself**; that defection is the most common way this workflow degrades into a normal
ad-hoc edit session.

Communicate with the user in Polish (their preference). Subagent prompts can be in English.

## Roles at a glance

| Stage | Who | `subagent_type` | `model` | Can edit files? |
|-------|-----|-----------------|---------|-----------------|
| 1. Plan | Opus architect | `Plan` | `opus` | No (read-only) |
| 3. Implement | Sonnet builder | `general-purpose` | `sonnet` | Yes |
| 4a. Checks | You (orchestrator) | — | — | No — run `pnpm verify` |
| 4b. Review | Codex CLI | — (Bash) | Codex default | No — read-only sandbox |

Set `model` explicitly on every `Agent` call — it overrides the agent definition and is what pins each
stage to the right tier. Subagents **do not share context with each other or with you**, so every stage's
inputs must be passed in the prompt. Carry the plan in a **file** (see below), not by retyping it.

---

## Stage 0 — Frame the task & quick clarify

Restate the task in one or two sentences and confirm you understand the goal before spending Opus tokens on
planning. If the request is a vague one-liner, ask the user what "done" looks like first — a fuzzy goal
produces a fuzzy plan and wastes the whole pipeline.

Pick a short working slug for the task (e.g. `add-token-revoke`). You'll reuse it for the plan file, the
task branch name (Stage 3), and subagent labels.

### Starting from a prepare-ticket document

If the task arrives with a ticket produced by the `prepare-ticket` skill, the requirements round has
already happened — deeper than this stage does it, and against the code rather than from memory.

- **Detect it.** The invocation carries a path like `.tickets/<slug>.md`, or the user points at one. If
  you only get a task name, glob `.tickets/` before you start asking anything.
- **Read the whole ticket** and take the slug from its `**Slug:**` field instead of inventing one — that
  keeps the ticket, the plan file and the branch under a single name.
- **Skip `### Quick clarify` entirely.** Scope, acceptance criteria and the explicit „Poza zakresem" were
  already interrogated and written down; re-asking them wastes the user's turns and invites contradictory
  answers. Tell the user in one sentence that quick-clarify is being skipped because the ticket carries
  it — otherwise a skipped step just looks like a dropped one.
- **Pass the ticket's absolute path to the Stage 1 planner** in place of quick-clarify answers, and state
  that its `## Ustalenia` and `## Poza zakresem` are **binding**: the planner implements those decisions,
  it does not reopen them. The ticket's `## Otwarte punkty` are the planner's starting material for its
  own "Open questions".
- Stage 2 then opens with the ticket's `## Otwarte punkty` plus whatever the planner added after reading
  the code.

### Quick clarify — before planning

Before spawning the planner, do a **fast, top-of-mind analysis of the feature yourself**: no deep code
reading, no file spelunking. Based purely on the request and what you already know about the repo, surface
the handful of questions that obviously matter and would change the shape of the plan — e.g. scope
boundaries, intended behaviour / UX, hard constraints, edge cases, integration points, and what's explicitly
out of scope. Then ask the user the ones whose answers you can't reasonably assume.

- Batch discrete-choice questions via `AskUserQuestion` (up to 4 at once); ask genuinely open-ended ones in
  plain text.
- Keep it short and obvious-now — this is a quick pass over intent and scope, **not** a substitute for the
  deep open-questions round. If nothing important is ambiguous, skip it and move on.
- Carry the answers into the Stage 1 planner prompt so the plan starts from solid inputs.

This is deliberately distinct from Stage 2: here you pin down obvious intent and scope **before** planning,
so Opus doesn't burn tokens planning the wrong thing; Stage 2 handles the deeper technical decisions the
planner surfaces only after actually reading the code.

---

## Stage 1 — Plan (Opus, read-only)

Spawn one planning subagent:

- `subagent_type: "Plan"`, `model: "opus"`, label like `plan:<slug>`.
- The `Plan` agent is read-only by design — it produces a plan without touching code, which is exactly what
  you want here.

Give it the task statement **plus the answers from the Stage 0 quick-clarify**, so it plans against the
clarified scope rather than the raw request.

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

### Create a branch — before implementing

Before spawning the builder, create and switch to a new branch off the current branch. Run `git status`
first — if there's uncommitted work that isn't yours from this session, stash or ask the user rather than
branching over it. Name the branch `<type>/<slug>` following this repo's convention (visible in recent merged
branches: `feat/...`, `fix/...`, `docs/...`); pick `type` from the task's nature and reuse the Stage 0 slug:

    git checkout -b <type>/<slug>

Everything from here through Stage 6 (commit) happens on this branch, not on the base branch.

Spawn one implementation subagent:

- `subagent_type: "general-purpose"`, `model: "sonnet"`, label like `impl:<slug>`.
- In the prompt: give the **absolute path to the plan file** and instruct it to read that file plus
  `CLAUDE.md`, implement the plan faithfully, match surrounding code style, and **not** commit or push.
- Ask it to return a concise **change report**: files touched, notable decisions, anything it deviated from
  in the plan and why, and anything it couldn't complete.

If the task is large, it's fine to let one builder do the whole plan — keep it a single agent so the changes
stay coherent, rather than splitting one plan across parallel editors that would conflict.

---

## Stage 4 — Verify (checks + Codex review)

Verification has two halves. The reviewer is the **Codex CLI**, not a Claude subagent — an independent model
reviewing Claude's diff is a genuinely second opinion, where a Sonnet reviewer shares the blind spots of the
Sonnet builder. Nothing in this stage may edit files.

### 4a — Deterministic checks (you run them)

Run the repo's single verification entry point and report the **actual** output, never an assumption that it
passes:

    pnpm verify

That covers lint + typecheck + test for the whole monorepo (see `AGENTS.md`). Confirm the script still exists
in the root `package.json` before relying on it. Where feasible, also exercise the changed path end-to-end,
not just unit tests — this matches the user's standing preference for real end-to-end verification.

**If `pnpm verify` fails, skip 4b** and go straight to Stage 5 with the failing output as the defect list.
Reviewing a red tree wastes a Codex run on problems the compiler already found.

### 4b — Codex review

Write the review instructions to a file first — the prompt is long and multi-line, and passing it through
stdin avoids PowerShell/Bash quoting problems:

    <scratchpad>/codex-review-prompt-<slug>.md

The instructions should open with *"You are a read-only code reviewer. Do not modify any files."* and tell
Codex to:

1. Determine the diff itself — the builder's work is **staged, unstaged and untracked**, not yet committed
   (the commit is Stage 6). Have it start from `git status --porcelain`, `git diff`, `git diff --staged`, and
   read untracked files directly.
2. Read the plan at `<scratchpad>/plan-<slug>.md` (give the absolute path) and judge the diff **against that
   plan**: was everything implemented, and correctly? Check the plan's **verification criteria** specifically.
3. Report only concrete, reproducible defects — file, symptom, and evidence (failing input/state,
   expected-vs-actual, or the plan requirement violated). Vague "looks risky" notes are not defects.
4. Note that `pnpm verify` already passed, so lint/type/test failures are not what it is hunting for.
5. Return the verdict in the required JSON shape and nothing else.

Then run it, reading the prompt from stdin (`-`):

    codex exec -s read-only \
      --output-schema .claude/skills/plan-implement/codex-review-schema.json \
      -o <scratchpad>/codex-review-<slug>.json \
      - < <scratchpad>/codex-review-prompt-<slug>.md

- `--output-schema` pins the answer to `{verdict, summary, defects[]}` — the same shape Stage 5 consumes, so
  the fix loop doesn't have to parse prose. The schema lives next to this skill.
- `-o` writes the final message to a file; read that file for the verdict rather than scraping stdout.
- `-s read-only` still lets Codex run commands (`git`, `tsc`, …); it only blocks writes. That is exactly the
  reviewer-can't-edit property this stage needs.
- Give the Bash call a **long timeout** (`timeout: 600000`) or run it in the background — a review of a
  sizeable diff takes minutes, well past the 120 s default.

**Why plain `codex exec` and not `codex exec review`:** verified against `codex-cli 0.145.0` — `exec review`
refuses a custom prompt together with a scope flag (`--uncommitted` errors with *"cannot be used with
[PROMPT]"*), and it **ignores `--output-schema`**, returning prose. Since this stage needs both plan-aware
instructions and a machine-readable verdict, `exec review` can't serve it. `codex exec review --uncommitted`
remains fine for a quick, generic, human-read review — just not for this loop. Re-check these constraints if
the CLI version moves substantially.

Read the JSON, then relay to the user: the `pnpm verify` result and Codex's `verdict` + `summary`. Treat
`FAIL`, or any `blocker`/`major` defect, as a failing verdict for Stage 5. `minor` defects alone are a
judgement call — surface them to the user instead of silently looping.

**If Codex itself fails to run** (not logged in, network error, non-zero exit with no report), don't skip
verification: say so, and fall back to a Sonnet reviewer (`general-purpose`, `sonnet`, label `verify:<slug>`)
prompted with *"You are a read-only verifier. Do not modify any files. Report findings only."*, the plan file
path, and the builder's change report — requiring the same `PASS` / `FAIL` + numbered defects verdict.

---

## Stage 5 — Fix loop

If the verdict is `FAIL` — from `pnpm verify`, from Codex, or both:

1. Spawn a **fresh** implementation subagent (`general-purpose`, `sonnet`) with the plan file path, the prior
   change report, and the defect list — the failing `pnpm verify` output and/or the `defects[]` array from
   Codex's JSON report. Instruct it to fix exactly those defects. Pass the defects inline in the prompt; the
   builder has no access to your context.
2. Re-run Stage 4 verification (4a, then 4b if 4a is green).
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
3. On approval, commit to the task branch created in Stage 3. End the commit message with the required
   trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
4. Do **not** push yet — pushing and opening the PR happen in Stage 7, as their own explicit-yes gate.

---

## Stage 7 — Open a pull request

After the commit lands:

1. **Ask** the user whether to push the branch and open a PR — this is visible, hard-to-reverse, shared-state
   territory (push + a public PR), so it gets its own explicit yes, separate from the Stage 6 commit
   approval. Don't fold the two together even if the user tends to say yes to both.
2. On approval: push the branch (`git push -u origin <type>/<slug>`) and create the PR with `gh pr create`,
   targeting the repo's default base branch. Pull the content from the plan file and the final verification
   result rather than re-deriving it.
   - **Title and body follow [`.github/pull_request_template.md`](../../../.github/pull_request_template.md)** —
     read it and fill its sections. `gh pr create --body` **ignores** the template file (it only auto-fills
     interactive/web PR creation), so applying it here is on you, not on `gh`.
   - Keep the section order and headings; drop only the sections the template marks optional when they'd be
     empty. Strip the HTML guidance comments — they're instructions for the author, not PR content.
   - If the task came from a ticket, take „Problem / Kontekst" and the roadmap/backlog item being closed
     from the ticket's `**Źródło:**` header rather than re-deriving them.
   - Fill the Weryfikacja checkboxes with **real results** (test counts, Codex verdict, what was clicked
     through E2E). A step that wasn't run stays unchecked with a one-line reason — never check it optimistically.
3. Report the PR URL back to the user. Do **not** merge it — opening the PR ends this workflow.

---

## Notes & pitfalls

- **Context isolation is the whole reason for the plan file.** If a subagent seems to "forget" the task, the
  cause is almost always missing context in its prompt — pass the plan file path and the relevant prior
  report every time.
- **Don't skip the human gate (Stage 2).** Silently guessing answers to open questions is how the wrong thing
  gets built well.
- **Keep the tiers right.** Opus for planning is worth it; downgrading the planner to save tokens is a false
  economy because a bad plan costs far more downstream. Sonnet is the right tier for the builder.
- **The Codex review is the point of Stage 4b, not a formality.** Don't replace it with a Claude subagent
  because it's slower or because the diff "looks fine" — an outside model is the only part of this pipeline
  that doesn't share the builder's assumptions. Fall back to a Sonnet reviewer only when Codex genuinely
  can't run, and say so out loud when you do.
- **Codex prerequisites:** `codex --version` and `codex login status` (expect `Logged in …`). Codex needs a
  git repo, which Stage 3's branch guarantees. Running `codex` from Bash may hit a permission prompt the
  first time.
- **You orchestrate, you don't build.** If you find yourself editing source files directly, you've dropped
  out of the workflow — delegate it to a Stage 3 subagent instead.
- If a stage's subagent returns `null` (skipped or died), don't fabricate its result — tell the user and
  decide whether to re-spawn.
- **Branch and PR are orchestrator actions, not subagent ones.** You create the branch (Stage 3) and push /
  open the PR (Stage 7) yourself via `git`/`gh` — don't delegate them to a subagent, and don't skip the
  Stage 7 approval gate just because Stage 6's commit was already approved.
