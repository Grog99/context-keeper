---
name: plan-implement
description: >-
  Orchestrated end-to-end workflow that takes a non-trivial task from idea to committed code.
  An Opus subagent plans, the user answers the plan's open questions, a separate Opus subagent
  writes the tests first (they must fail before implementation), a Sonnet subagent implements without
  touching those tests,
  then `pnpm verify` plus an independent Codex CLI review (`codex exec`) repeat with fixes until green,
  a Sonnet docs agent updates `context/`, README and `AGENTS.md` to match what shipped (with its own
  Codex review), and it commits only after the user approves. Use this whenever the user wants a feature, refactor,
  or bugfix carried through planning and verification rather than implemented ad hoc — e.g.
  "zaplanuj i zaimplementuj X", "weź to zadanie od planu do commita", "zbuduj funkcję Y z weryfikacją",
  "plan and implement", "implement this properly with a verification pass". Prefer this skill over
  jumping straight to edits whenever a task is big enough to deserve a written plan and an independent check.
---

# Plan → Implement → Verify → Commit

This skill orchestrates a task through several stages using **model-specialised subagents**: Opus plans
(thinking-heavy, read-only), a separate Opus test-writer pins the planned behaviour in tests *before* any
code exists (so the builder never writes the tests that judge its own code), Sonnet implements
(execution-heavy). Verification is deliberately **not** a
Claude subagent — it is `pnpm verify` plus the **Codex CLI** reviewing the diff, so the code is judged by a
model outside the family that wrote it. Once the code has passed verification, a Sonnet docs agent brings
the documentation in line with what actually shipped, and Codex reviews that diff too. You stay the
**orchestrator** — your job is to spawn subagents, run
the verification pass, carry state between stages, talk to the user, and drive the fix loop. **Do not
implement the task yourself**; that defection is the most common way this workflow degrades into a normal
ad-hoc edit session.

Communicate with the user in Polish (their preference). Subagent prompts can be in English.

## Roles at a glance

| Stage | Who | `subagent_type` | `model` | Can edit files? |
|-------|-----|-----------------|---------|-----------------|
| 1. Plan | Opus architect | `Plan` | `opus` | No (read-only) |
| 2b. Tests first | Opus test-writer | `general-purpose` | `opus` | Only test files (`apps/server/test/**`, `apps/dashboard/test/**`) — never `src/` |
| 3. Implement | Sonnet builder | `general-purpose` | `sonnet` | Yes — except test files |
| 4a. Checks | You (orchestrator) | — | — | No — run `pnpm verify` |
| 4b. Review | Codex CLI | — (Bash) | Codex default | No — read-only sandbox |
| 5b. Docs | Sonnet docs agent | `general-purpose` | `sonnet` | Only docs: `context/**` (not `context/archive/**`), `README.md`, `AGENTS.md`, `docs/**` |
| 5b. Docs review | Codex CLI | — (Bash) | Codex default | No — read-only sandbox |

Set `model` explicitly on every `Agent` call — it overrides the agent definition and is what pins each
stage to the right tier. Subagents **do not share context with each other or with you**, so every stage's
inputs must be passed in the prompt. Carry the plan in a **file** (see below), not by retyping it.

---

## Stage 0 — Frame the task & quick clarify

Restate the task in one or two sentences and confirm you understand the goal before spending Opus tokens on
planning. If the request is a vague one-liner, ask the user what "done" looks like first — a fuzzy goal
produces a fuzzy plan and wastes the whole pipeline.

Pick a short working slug for the task (e.g. `add-token-revoke`). You'll reuse it for the plan file, the
task branch name (Stage 2), and subagent labels.

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
- **A ticket's „Poza zakresem" cannot cut documentation updates** — the docs scope comes only from the
  plan's „Dokumentacja" section. If a ticket does exclude docs, the planner raises it as an Open question
  instead of silently writing `Brak zmian w dokumentacji, bo …`.

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
4. **Testy** — the behaviours this task must pin with tests. For each one: its marking, the layer, and the
   target test file (new or existing, named per `context/testing.md`).
   - `[czerwony]` — new or changed behaviour; the test must **fail** before implementation (a failure on a
     missing import counts).
   - `[strażnik]` — behaviour that must survive the change (e.g. in a refactor); the test already passes.
   - Include existing tests whose expectations this task changes — they become `czerwony`, because the
     builder may not edit tests.
   - Or state explicitly `Brak testów, bo …` with the reason (docs, skills, pure config).
   - Behaviours, not implementation details, and only where `context/testing.md` says tests pay off.
5. **Dokumentacja** — the docs that Stage 5b must update. One line per place under `context/` (not
   `context/archive/`), `README.md`, `AGENTS.md` or `docs/` that this change makes stale or that must
   describe it: file, section, what changes.
   - Include, when applicable: the `context/roadmap.md` item this task closes (⬜→✅ plus a description of
     what shipped; any further roadmap item only with the user's explicit approval in Stage 2);
     `context/backlog.md` entries the task adds or closes; durable decisions from the
     ticket's `## Ustalenia` (behaviour or convention, not task steps) and where they belong in the canon.
   - Or state explicitly `Brak zmian w dokumentacji, bo …` with the reason.
   - Not here: docs that are themselves the task's deliverable (they stay in Concrete steps, for the
     builder); code comments (Concrete steps); version close-out — archive, README status line, roadmap
     restructuring (`roadmap-reconcile`); drift unrelated to this change (`tech-reconcile`).
6. **Verification criteria** — how success will be checked (which tests, which command paths, which
   end-to-end flow to exercise).
7. **Open questions** — every ambiguity or decision that needs the user. If there are none, say so
   explicitly.

Tell it to read `CLAUDE.md`, `context/testing.md` (the test convention), `context/roadmap.md` and
`context/backlog.md` (to find the item this task closes) and relevant existing code so the plan matches
repo conventions.

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
standing preference: larger changes get a short plan accepted before any files are edited. Do not proceed
without that yes.

The plan's **Testy** section is part of what the user accepts here. It decides whether Stage 2b runs: a list
of behaviours means the test-writer runs next; `Brak testów, bo …` means it is skipped. If the user changes
the list, fold the change into the plan file before moving on.

The plan's **Dokumentacja** section is accepted here too. It decides whether Stage 5b runs: a list means
the docs agent runs after verification; `Brak zmian w dokumentacji, bo …` means it is skipped. Fold the
user's changes into the plan file here as well.

### Create the task branch — after the go-ahead

Once the user has said yes, create and switch to a new branch off the current branch — the test-writer
(Stage 2b) already writes onto it. Run `git status` first — if there's uncommitted work that isn't yours from
this session, stash or ask the user rather than branching over it. Name the branch `<type>/<slug>` following
this repo's convention (visible in recent merged branches: `feat/...`, `fix/...`, `docs/...`); pick `type`
from the task's nature and reuse the Stage 0 slug:

    git checkout -b <type>/<slug>

Everything from here through Stage 6 (commit) happens on this branch, not on the base branch.

---

## Stage 2b — Tests first (Opus test-writer)

Tests are the specification, so they are written *before* the code, by an agent that has never seen the
implementation. The builder later makes them pass; it does not get to reshape them. The behaviours to pin are
exactly the plan's **Testy** list — the test-writer realises it, it does not decide the scope.

### Skip rule

If **Testy** says `Brak testów, bo …`, skip this stage: tell the user in one line, record
`Stage 2b skipped: <reason>` in the plan file, and move on to Stage 3. With the stage skipped there is no test
snapshot, so none of the snapshot checks below apply later. Never run the test-writer on an empty list.

### Spawn the test-writer

- `subagent_type: "general-purpose"`, `model: "opus"`, label like `tests:<slug>`.
- The prompt carries the **absolute path to the plan file**, `context/testing.md` and `CLAUDE.md`, and says:
  - Write **exactly** the tests listed in **Testy** — do not add, drop or reinterpret any. Anything the list
    asks for that cannot be expressed as a test goes into the report, not into a guess.
  - Edit or create only test files under `apps/server/test/` (including `helpers/`) or `apps/dashboard/test/`. Never touch `src/`,
    configs or `package.json`.
  - `czerwony` tests assert the **new** behaviour and must fail right now. Importing an export that does not
    exist yet is allowed (it fails at call time). A red test that needs a not-yet-existing *module* goes into
    a **new spec file holding only red tests**: a module-load failure fails the whole file, including guards
    and pre-existing tests.
  - `strażnik` tests must pass against the current code.
  - Follow `testing.md` for mocking and naming (fakes come from `helpers/fakes.ts`; do not copy them).
  - Run the vitest command from "Red/guard check" below on the files it touched before returning.
  - Also run typecheck and lint on the test files it touched before returning — Vitest does not typecheck, and
    a type or lint error in a frozen test cannot be fixed by the builder: `pnpm typecheck` and
    `pnpm exec eslint <touched test files>`.
  - Do not `git add`, commit or push.
  - Return a **manifest**: one line per added or changed test with the repo-relative file, the vitest
    `fullName` (describe titles + test title, space-separated), the plan item and `czerwony`/`strażnik`; the
    list of touched files; and the plan items it could not express, with the reason.

### Boundary check (you run it)

`git status --porcelain` may show only paths under `apps/server/test/` and `apps/dashboard/test/`. Anything else → stop and report it to
the user; do not silently revert.

### Red/guard check (you run it)

If any touched file is an integration, migration or e2e spec, confirm Docker is up first (`docker info`) — a
test that fails because Docker is down is not red. Then, from Bash:

    pnpm --filter @context-keeper/server exec vitest run test/<a>.spec.ts test/<b>.integration.spec.ts \
      --reporter=json --outputFile="<scratchpad>/tests-red-<slug>.json"

For specs under `apps/dashboard/test/` run the dashboard variant instead (or in addition, one command per app):

    pnpm --filter @context-keeper/dashboard exec vitest run test/<a>.spec.ts \
      --reporter=json --outputFile="<scratchpad>/tests-red-<slug>-dashboard.json"

Paths are relative to the respective app (`apps/server` or `apps/dashboard`), with forward slashes and the
`test/` prefix (positional arguments are substring filters). The dashboard has no integration specs, so
there is no Docker dependency there. Use `timeout: 600000`. A non-zero exit is expected — judge from the JSON, not the exit
code.

Judge `testResults[].assertionResults[]` (`fullName`, `status`):

- every manifest `czerwony` test must be `"failed"`;
- every manifest `strażnik` test, and every pre-existing test in a modified existing file that is not in the
  manifest, must be `"passed"`;
- a file with `testResults[i].status === "failed"` and an empty `assertionResults` is a load error (e.g. a
  missing module). It counts as red for its tests only if **every** manifest test in it is `czerwony` and the
  file is new;
- `skipped` / `todo` / `pending`, a manifest test missing from a file that did load, or a test that is in
  neither the manifest nor the pre-existing set → violation;
- a failure in `beforeAll` or a hook timeout is an environment problem (e.g. Docker), not red — fix the
  environment and rerun.

### On violation

A `czerwony` test that passes, or a `strażnik` that fails: stop before Stage 3. If the evidence says the
plan's assumption about current behaviour is wrong, take it to the user. Otherwise spawn **one** fresh
test-writer (same settings) with the specific failing items and rerun the check. If it still fails, hand it to
the user.

### Snapshot

After the check passes, freeze the tests in the index (no commit — that happens in Stage 6):

    git add -- <every touched test file>
    git ls-files -s -- <the same files>

Append a `## Test snapshot (Stage 2b)` section to the plan file with the file list, the `git ls-files -s`
output and the manifest.

### Snapshot check (after Stage 3 and after every Stage 5 round)

- `git status --porcelain -- apps/server/test apps/dashboard/test` must list exactly the snapshot files, each with an empty
  worktree column (`A  path` / `M  path`). Any `??`, ` M`, `MM`, `AM` or ` D` is a violation.
- `git ls-files -s -- <files>` must equal the saved output (this catches a builder that staged its own edits).
- `git diff --stat -- <files>` as evidence.

On a violation: stop and show the user the diff. Propose `git restore --worktree -- <files>` (it restores the
files from the snapshot in the index) plus a re-spawned builder, and act on the user's decision — do not
revert on your own.

---

## Stage 3 — Implement (Sonnet)

The task branch already exists (created at the end of Stage 2). Spawn one implementation subagent:

- `subagent_type: "general-purpose"`, `model: "sonnet"`, label like `impl:<slug>`.
- In the prompt: give the **absolute path to the plan file** and instruct it to read that file plus
  `CLAUDE.md`, implement the plan faithfully, match surrounding code style, and **not** commit or push.
- **Tests are frozen.** Tell it: do not create, edit, delete, rename, `git add`, `git restore` or `git stash`
  any test file (`apps/server/test/**`, including `helpers/`, and `apps/dashboard/test/**`) — the tests are the specification. Make them pass
  by changing code only. If it believes a test is wrong, it leaves the test as is and lists it in the report
  under **Disputed tests** (test, why, evidence: plan line vs. test expectation).
  - Exception: when Stage 2b was skipped and the plan's Concrete steps explicitly list changes to test files
    (e.g. refactoring test helpers), the builder makes exactly those changes and no others.
- The plan's **Dokumentacja** section is not the builder's job — Stage 5b does it after verification. The
  builder edits docs files only where Concrete steps name them.
- Ask it to return a concise **change report**: files touched, notable decisions, anything it deviated from
  in the plan and why, anything it couldn't complete, and **Disputed tests** (if any).

If the task is large, it's fine to let one builder do the whole plan — keep it a single agent so the changes
stay coherent, rather than splitting one plan across parallel editors that would conflict.

After the builder returns, run the **snapshot check** (Stage 2b, if it ran) before Stage 4.

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
Reviewing a red tree wastes a Codex run on problems the compiler already found. A failing snapshot test from
Stage 2b is a **code defect** by default (the tests are the specification), unless the builder disputed it.

### 4b — Codex review

Write the review instructions to a file first — the prompt is long and multi-line, and passing it through
stdin avoids PowerShell/Bash quoting problems:

    <scratchpad>/codex-review-prompt-<slug>.md

The instructions should open with *"You are a read-only code reviewer. Do not modify any files."* and tell
Codex to:

1. Determine the diff itself — the work is **staged, unstaged and untracked**, not yet committed (the commit
   is Stage 6). Have it start from `git status --porcelain`, `git diff`, `git diff --staged`, and read
   untracked files directly. If Stage 2b ran, **staged** changes under `apps/server/test/` or `apps/dashboard/test/` are the
   test-writer's frozen tests and **unstaged + untracked** changes are the builder's code — it must review
   both halves, and any unstaged change to a staged test file is a blocker.
2. Read the plan at `<scratchpad>/plan-<slug>.md` (give the absolute path) and judge the diff **against that
   plan**: was everything implemented, and correctly? Check the plan's **verification criteria** specifically.
   Items in the plan's **Dokumentacja** section are done later (Stage 5b), so their absence from the diff is
   not a defect.
3. If Stage 2b ran, evaluate the tests against the plan's **Testy** section (give the absolute path of
   `context/testing.md` too): is every listed behaviour pinned, are `czerwony`/`strażnik` honoured, does each
   test assert observable behaviour (not just an import), are there tests beyond the list, are mocks used per
   `testing.md`? Report a test defect with the **test file path in `file`**.
4. Report only concrete, reproducible defects — file, symptom, and evidence (failing input/state,
   expected-vs-actual, or the plan requirement violated). Vague "looks risky" notes are not defects.
5. Note that `pnpm verify` already passed, so lint/type/test failures are not what it is hunting for.
6. Return the verdict in the required JSON shape and nothing else.

Then run it, reading the prompt from stdin (`-`):

    codex exec -s read-only \
      --output-schema .claude/skills/plan-implement/codex-review-schema.json \
      -o <scratchpad>/codex-review-<slug>.json \
      - < <scratchpad>/codex-review-prompt-<slug>.md

- `--output-schema` pins the answer to `{verdict, summary, defects[]}` — the same shape Stage 5 consumes, so
  the fix loop doesn't have to parse prose. The schema lives next to this skill. It has no field for the kind
  of defect, so Stage 5 routes by the `file` path (under `apps/server/test/` or `apps/dashboard/test/` = test defect).
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

If the verdict is `FAIL` — from `pnpm verify`, from Codex, or both — first **partition the defects**:

- **Test defects:** Codex defects whose `file` is under `apps/server/test/` or `apps/dashboard/test/`, plus the builder's **Disputed
  tests**. If a defect challenges the plan's **Testy** item itself (the plan is wrong, not the test) → take it
  to the user.
- **Code defects:** everything else, including a failing snapshot test from `pnpm verify`.

Then:

1. **Test defects →** spawn a **fresh** test-writer (`general-purpose`, `opus`, label `tests-fix:<slug>`) with
   the plan file path, the manifest and the defects. It may edit only the test files the defects name, under
   the same rules as Stage 2b. Afterwards refresh the snapshot (`git add` + `git ls-files -s`) and update the
   plan file. A red re-check is no longer possible here; `pnpm verify` judges the result.
2. **Code defects →** spawn a **fresh** implementation subagent (`general-purpose`, `sonnet`) with the plan file
   path, the prior change report, and the defect list — the failing `pnpm verify` output and/or the
   `defects[]` entries from Codex's JSON report. Instruct it to fix exactly those defects, with the same
   no-test-edits prohibition as in Stage 3. Pass the defects inline in the prompt; the builder has no access
   to your context.
3. If both kinds are present, run the test-writer first, then the builder.
4. Run the snapshot check (if Stage 2b ran), then re-run Stage 4 verification (4a, then 4b if 4a is green).
5. Repeat until `PASS` or until **3 fix→verify rounds** have passed — the limit covers both kinds of defects
   combined.

If it still fails after 3 rounds, stop looping and hand the outstanding defects to the user with a short
diagnosis — burning more rounds usually means the plan itself is wrong, which is a decision for the user, not
another retry.

Keep the user informed between rounds (one line: what failed, what's being fixed).

When the verdict is `PASS` — straight from Stage 4 or after the loop — go to Stage 5b.

---

## Stage 5b — Dokumentacja (Sonnet docs agent + Codex docs review)

Docs are written **once, against code that has already passed verification** — they describe what shipped,
not what was intended. The scope is the plan's **Dokumentacja** list plus any place the diff made stale.

### Skip rule

If **Dokumentacja** says `Brak zmian w dokumentacji, bo …`, skip this stage — both the agent and the Codex
docs round: tell the user in one line, record `Stage 5b skipped: <reason>` in the plan file, and go to
Stage 6. Never run the docs agent on an empty list "na sucho".

### Baseline (you run it)

The worktree already holds the builder's code, so docs edits can only be told apart from it by freezing the
code first:

1. `git -c core.quotePath=false status --porcelain --untracked-files=all` — anything that is not this
   task's work → stop and ask the user.
2. `git add -A`. If Stage 2b ran, confirm `git ls-files -s -- <snapshot files>` still equals the output saved
   in the plan file.
3. Record `git write-tree` and `git diff --staged --stat` in the plan file under `## Docs baseline (Stage 5b)`.

From here on, **staged = the code after PASS; unstaged + untracked = the docs agent's work.**

### Spawn the docs agent

- `subagent_type: "general-purpose"`, `model: "sonnet"`, label like `docs:<slug>`.
- The prompt carries the absolute paths to the plan file, the ticket (if any), `CLAUDE.md` and `AGENTS.md`,
  and says:
  - The change is `git diff --staged` (nothing is committed yet). Read-only git only; no `git add`,
    `restore`, `stash`, `commit` or `push`.
  - Realise every **Dokumentacja** item. Then read the diff and update places outside the list that it made
    stale — listed separately in the report.
  - **Allowed edits:** `context/**` except `context/archive/**`, `README.md`, `AGENTS.md`, `docs/**`.
    Nothing else — not `apps/**` (comments and strings included), tests, `.claude/**`, configs, the ticket
    or the plan file.
  - A stale code comment or string, or code that does not do what the plan or ticket says, is **reported,
    not fixed**: a code change after Codex PASS would bypass verification.
  - `context/roadmap.md`: only the items listed in the plan's accepted **Dokumentacja** section — normally
    just the item this task closes; any other item only when the user approved it there in Stage 2. Status
    ⬜→✅ and a description rewritten to what shipped, in the style of the neighbouring ✅ items. No other
    items, no milestone header or status, "Cel fazy" or ordering; add no items.
  - `context/backlog.md`: only when the task added (deferred) or closed an entry; leave the
    „**Aktualizacja:**" line alone.
  - Never: `context/archive/**`, the README `> **Status:**` line, version close-out (`roadmap-reconcile`),
    drift this diff did not cause (`tech-reconcile`).
  - With a ticket: move its durable decisions from `## Ustalenia` (behaviour, convention — not task steps,
    not rationale the canon already holds) into `context/`. The ticket stays read-only.
  - Describe what the staged code actually does; where that differs from the plan, report a defect.
  - Write in Polish, matching each file's existing style; minimal edits, no rewriting of untouched
    sections. No `save_memory`, no MCP writes.
  - Return a report with: 1. realised **Dokumentacja** items (file/section + what changed, or not done +
    why); 2. additions outside the list (file/section + the code path that made it stale); 3. ticket
    decisions moved (ticket # → file/section, or „brak ticketu"); 4. `save_memory` candidates (`kind`,
    proposed text, why it is not derivable from the repo); 5. code or comment defects noticed (`file:line`,
    symptom, evidence); 6. touched files.

### Boundary check (you run it, after every docs-agent run)

In `git -c core.quotePath=false status --porcelain --untracked-files=all`, every line with `??` or a
non-space second column is the docs agent's. Each such path must (a) not start with `context/archive/`, and
(b) start with `context/` or `docs/`, or be exactly `README.md` or `AGENTS.md`. Also `git write-tree` must
still equal the recorded baseline (the agent staged nothing). Any violation → stop and show the user; do not
revert on your own. Evidence: `git diff --stat` plus `git ls-files --others --exclude-standard`.

### Codex docs review

Write `<scratchpad>/codex-docs-prompt-<slug>.md`, opening with *"You are a read-only documentation
reviewer. Do not modify any files."*, and tell Codex to:

1. Review the docs diff: **unstaged + untracked** changes (`git diff`, `git ls-files --others
   --exclude-standard`, read those files). Staged changes (`git diff --staged`) are the task's code,
   already reviewed — reference only.
2. Check exactly two things: (a) the docs describe the code on the branch — behaviour, commands, paths,
   names and config match the staged code and current files; (b) the docs cover every item of the plan's
   **Dokumentacja** section (give the absolute plan path), each one realised or justified.
3. Report concrete defects only; `file` = the docs file with `:line`. If the problem is that the code
   contradicts the plan, `file` = the code path.
4. Leave out style, wording preferences, drift unrelated to this diff and version-level items.
5. Return the verdict in the required JSON shape and nothing else.

Then run it (`timeout: 600000`):

    codex exec -s read-only \
      --output-schema .claude/skills/plan-implement/codex-review-schema.json \
      -o <scratchpad>/codex-docs-<slug>.json \
      - < <scratchpad>/codex-docs-prompt-<slug>.md

The schema is the one from 4b, unchanged; route defects by `file`. The verdict rule is the same as in 4b:
`FAIL` or any `blocker`/`major` fails, `minor` alone is surfaced to the user. If Codex fails to run, say so
and fall back to a read-only Sonnet reviewer (`general-purpose`, `sonnet`, label `verify-docs:<slug>`) with
the same two checks and the same `PASS` / `FAIL` + numbered defects verdict.

### Docs fix loop

- **Docs defects** (`file` is an allowed docs path): spawn a **fresh** docs agent (label `docs-fix:<slug>`,
  same rules) with the plan path, the previous report and the defects inline → boundary check → Codex docs
  review again. Limit: **2 fix→re-review rounds** (at most 3 Codex docs runs); then the human decides. These
  rounds do not count toward Stage 5's 3.
- **Code defects** — a Codex defect whose `file` is a code path, or an item in the agent's report section
  5 — **always go to the human**, never to a builder: Codex already passed this code. The human either
  accepts it (PR „Znane ograniczenia" or backlog) or sends the task back to Stage 5. Not counted in
  Stage 5's rounds.
- **Going back to Stage 5 (human decision only):** unstage the baseline but keep the test snapshot —
  `git restore --staged -- . ":(exclude)apps/server/test" ":(exclude)apps/dashboard/test"` (if Stage 2b was
  skipped: `git restore --staged -- .`). Docs edits stay in the worktree. After the next Stage 4 PASS, rerun
  Stage 5b in full with a new baseline.

---

## Stage 6 — Commit

Once verification passes and Stage 5b is done or skipped:

1. Summarise for the user what was built and the final verification result (real command output). Also
   cover the Stage 5b result: the places from the docs report (sections 1-3) plus the Codex docs verdict and
   summary, or the skip reason; the docs `git diff --stat`, with the `context/roadmap.md` and
   `context/backlog.md` hunks shown in full so the human can check them; and any open code defects the docs
   agent reported.
2. **Memory candidates.** List the docs agent's `save_memory` candidates and propose each one. Call
   `save_memory` yourself only for those the user picks, after `search_memory` so a correction uses
   `supersedes` instead of adding a duplicate.
3. **Ask** whether to commit, and propose a commit message. Commit only on an explicit yes — never commit or
   push unprompted.
4. On approval, commit to the task branch created in Stage 2. If Stage 2b ran, the snapshot test files are
   already staged — stage the rest of the changes before committing; if Stage 5b ran, the code is already
   staged as its baseline, so `git add -A` the docs changes before committing. End the commit message with
   the required trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
5. Do **not** push yet — pushing and opening the PR happen in Stage 7, as their own explicit-yes gate.

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
   - The Dokumentacja checkbox: fill it with the files updated, or with `pominięto: <reason>` taken from
     `Stage 5b skipped: …`, plus the Codex docs verdict. It is checked when Stage 5b passed or its skip was
     accepted in Stage 2; unchecked with a one-line reason only when the human accepted a `FAIL`. If the
     fallback reviewer was used, say so.
3. Report the PR URL back to the user. Do **not** merge it — opening the PR ends this workflow.

---

## Notes & pitfalls

- **Context isolation is the whole reason for the plan file.** If a subagent seems to "forget" the task, the
  cause is almost always missing context in its prompt — pass the plan file path and the relevant prior
  report every time.
- **Don't skip the human gate (Stage 2).** Silently guessing answers to open questions is how the wrong thing
  gets built well.
- **Keep the tiers right.** Opus for planning is worth it; downgrading the planner to save tokens is a false
  economy because a bad plan costs far more downstream. Opus also writes the tests: they are the
  specification, so weaker edge-case coverage there is paid for in every later stage. Sonnet is the right tier
  for the builder. Sonnet is also enough for the docs agent: the accepted plan section sets its scope and
  Codex checks the substance.
- **Docs come after PASS, never before or alongside the builder.** They describe what shipped, not the
  intent. The docs agent never touches code or comments — a stale comment is a defect for the human.
- **`save_memory` runs only from you, in Stage 6.** The docs agent only proposes candidates.
- **Version close-out belongs to `roadmap-reconcile`, whole-canon audits to `tech-reconcile`** — Stage 5b
  handles only what this diff changed.
- **Tests are frozen after Stage 2b — only a test-writer changes them.** Don't let the builder "fix" a red test
  to get green; a test it finds wrong goes into **Disputed tests**, and Stage 5 routes it.
- **The Codex review is the point of Stage 4b, not a formality.** Don't replace it with a Claude subagent
  because it's slower or because the diff "looks fine" — an outside model is the only part of this pipeline
  that doesn't share the builder's assumptions. Fall back to a Sonnet reviewer only when Codex genuinely
  can't run, and say so out loud when you do.
- **Codex prerequisites:** `codex --version` and `codex login status` (expect `Logged in …`). Codex needs a
  git repo, which the task branch (created in Stage 2) guarantees. Running `codex` from Bash may hit a permission prompt the
  first time.
- **You orchestrate, you don't build.** If you find yourself editing source files directly, you've dropped
  out of the workflow — delegate it to a Stage 3 subagent instead.
- If a stage's subagent returns `null` (skipped or died), don't fabricate its result — tell the user and
  decide whether to re-spawn.
- **Branch and PR are orchestrator actions, not subagent ones.** You create the branch (Stage 2) and push /
  open the PR (Stage 7) yourself via `git`/`gh` — don't delegate them to a subagent, and don't skip the
  Stage 7 approval gate just because Stage 6's commit was already approved.
