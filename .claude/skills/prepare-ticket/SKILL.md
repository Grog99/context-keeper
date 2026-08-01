---
name: prepare-ticket
description: >-
  Turns a roadmap item, backlog entry, bug or loose idea into a written ticket: gathers the
  requirements, reads the code for every answer the repo already holds, then runs a „grill me"
  interrogation — one question per turn, each carrying a recommended answer, descending the decision
  tree and resolving dependencies in order — and writes the settled decisions to
  `.tickets/<slug>.md`. Use whenever a task needs its requirements and design decisions pinned down
  before anyone plans or writes code — e.g. „przygotuj ticket z tej pozycji roadmapy", „zbierz
  wymagania do X", „przepytaj mnie o ten feature", „spisz ustalenia zanim zaczniemy", „prepare a
  ticket for this bug", „grill me on this feature". This skill ends at the ticket — it does not plan
  the implementation and does not touch code; hand the finished ticket to `plan-implement` for that.
---

# Prepare ticket

Take a task from a one-line roadmap entry or a bug report to a written set of decisions: what we are
building, where the scope ends, which design calls were made and why. **Read before you ask — a
question the repo can answer is not a question for the human.** Every turn you spend asking about
something a `grep` would have settled is a turn wasted, and worse: an answer from memory where the
code was available.

Talk to the user in Polish; the ticket itself is written in Polish, like the rest of `context/`.

You produce **decisions, not a plan**. How to build it — file-by-file steps, branch, verification
loop — belongs to `plan-implement`, which consumes this ticket.

---

## 1. Identify the task and its source

Work out what is being ticketed: a roadmap item, a backlog entry, a finding from the technical
review, a bug, or a loose idea straight from the user.

- This repo has **no item IDs** — entries are identified by their bolded Polish name. Match by name
  in [`context/roadmap.md`](../../../context/roadmap.md),
  [`context/backlog.md`](../../../context/backlog.md) and
  [`context/tech-review.md`](../../../context/tech-review.md). If several entries could be meant, ask
  which one; do not pick the closest match silently.
- Read the matched entry **and what it links to** — a debt item usually points at a numbered finding
  in `tech-review.md` that already carries symptom, evidence and a proposed fix.
- Call `mcp__context-keeper__search_memory` (the proactive mode required by
  [`AGENTS.md`](../../../AGENTS.md)) so the interrogation does not re-litigate decisions that have
  already been made and saved.

Pick a **short kebab-case slug** (e.g. `redact-set-cookie`). `plan-implement` will reuse it for the
plan file and the branch, so the ticket, the plan and the branch all carry one name.

## 2. Map the ground before asking anything

Read the code first. This step is what makes the grill worth the user's time.

- For anything wider than a single known file, fan out **up to 3 `Explore` agents in one message**,
  on separate concerns: (a) the current implementation and its call sites, (b) neighbouring
  conventions and existing helpers worth reusing, (c) tests and the verification surface.
- Read the canon that constrains the task: [`context/tech-stack.md`](../../../context/tech-stack.md)
  (cite its `§N` sections), [`context/prd.md`](../../../context/prd.md),
  [`context/mcp-tool-contract.md`](../../../context/mcp-tool-contract.md) when the MCP surface is
  touched, [`context/design-system.md`](../../../context/design-system.md) when the dashboard is.
- **Verify every `file:line` a subagent cites, in the source, before writing it down** — subagents
  report inconsistent line numbers (`AGENTS.md`, „Zasady pracy").

The product of this step is a list of facts established from the code. Those stop being questions.

## 3. Build the decision tree

List the decisions that would **change the implementation**. Anything that would not is not a
decision, it is trivia — drop it.

For each node record the question, what depends on it, and its state:

- **settled by code** → becomes an ustalenie with `file:line`;
- **settled by canon or memory** → becomes an ustalenie with the citation;
- **needs the human** → goes into the question queue;
- **dead after a parent's answer** → pruned, with a note that it was pruned.

Order by dependency: a parent whose answer can delete an entire subtree comes first. Never ask a
child before its parent.

Now create `.tickets/<slug>.md` from [`ticket-template.md`](ticket-template.md) and **append to it as
you go**. Context compaction mid-interrogation must not cost you the answers already given.

## 4. Calibrate the depth

Size the task from what steps 2–3 turned up: how many open nodes, how many files, whether it crosses
surfaces (MCP / API / DB / UI). Propose a depth:

- **S** — 1–3 questions, short ticket (a contained bugfix, one file, obvious fix);
- **M** — walk all open nodes;
- **L** — walk all open nodes plus an explicit scope-carving pass on what we are _not_ building.

Ask with a single `AskUserQuestion`; the user can raise or cut it. Say out loud that they can end the
grill at any turn with „wystarczy" — an interrogation with no exit is an interrogation people avoid.

## 5. Grill me

The interrogation loop. These rules are the skill:

- **One question per turn.** No batching, even when the questions look cheap. The answer to one
  reshapes the next, and a batch forces the user to answer them as if independent. This is a
  deliberate departure from the „batch up to 4 via `AskUserQuestion`" convention the other skills in
  this repo follow — do not „fix" it back.
- **Before every question, check whether the code answers it.** If a read or a grep settles it, do
  that instead: record it as an ustalenie with its `file:line` source and move to the next node.
  Never spend a turn on something the repo already says.
- **Every question carries your recommendation.** The recommended option goes **first**, marked
  `(Rekomendacja)`, with a one-line „dlaczego" in its description. When it is a genuine coin flip,
  say so — a fabricated preference is worse than none.
- **Descend the tree.** After each answer, re-walk the remaining nodes: prune the ones that answer
  just killed, add the ones it just opened. State briefly when an answer prunes a whole branch — it
  is the clearest evidence the interrogation is going somewhere.
- **Form.** Discrete choice → `AskUserQuestion`, one question, 2–4 options. Genuinely open-ended →
  plain text, still one question, and state your own proposed answer so the user can simply agree.
- **Write it down immediately.** After each answer, append the ustalenie to the ticket: the decision,
  the „dlaczego", and the alternative rejected. Do not batch the writes.

Stop when no open node would still change the implementation, or when the user calls it. Whatever is
left open goes to `## Otwarte punkty` along with what depends on it.

## 6. Finalise the ticket

Complete `.tickets/<slug>.md` against [`ticket-template.md`](ticket-template.md), creating the
directory if it does not exist. Requirements:

- acceptance criteria are **testable** — a sentence nobody can check is not a criterion;
- the scope carries an explicit „Poza zakresem"; „nie omówiliśmy tego" is not the same as „nie
  robimy tego";
- every ustalenie carries its „dlaczego" and the rejected alternative;
- code touch-points carry `file:line` verified in the source;
- the template's opening HTML comment is filling guidance — it does **not** go into the ticket.

## 7. Report and hand off

Summarise in Polish: what was settled, what the code answered for free, what stayed open. Then give
the hand-off line, ready to paste into a **new session**:

    /plan-implement .tickets/<slug>.md

Note that the ticket replaces `plan-implement`'s Stage 0 quick-clarify and goes into the Stage 1
planner prompt. Do not commit, and do not start implementing — a ticket followed by an unrequested
implementation defeats the point of writing one.

If the grill produced a non-obvious convention or decision worth keeping beyond this task, propose
saving it via `save_memory`.

---

## Notes & pitfalls

- **`.tickets/` is gitignored on purpose.** It is a working notebook, not canon; canon lives in
  `context/`. Nothing durable should exist only in a ticket — if a decision outlives the task, it
  belongs in `context/` or in `save_memory`.
- **The grill is not a survey.** A question with no bearing on the implementation wastes a turn, and
  a long list of them trains the user to stop reading the options.
- **A recommendation without a reason is worthless.** If you cannot say why in one line, you have not
  thought about it enough to recommend anything.
- **Do not slide into planning.** Naming files and functions is the planner's job in
  `plan-implement`; here you settle _what_ and _why_. Touch-points are evidence, not an
  implementation plan.
- **Do not touch code.** This skill reads the repo and writes one file under `.tickets/`. Nothing
  else.
