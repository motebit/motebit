# Goals vs tasks

A motebit acts on behalf of its user. The user declares **what** they want; the motebit figures out **how**. The user-declared thing is a **goal**. The how is **tasks**. Collapsing the two erases the line between the human's intent and the motebit's autonomy.

## The distinction

- **Goal** — an intended outcome. Strategic. Adaptive. Declared by the user. Examples: "draft a 3-day itinerary for Tokyo," "watch this Grafana dashboard and wake me if p99 latency crosses 300ms," "summarize every PR I'm tagged on every morning."
- **Task** — an actionable step. Tactical. Rigid. Emitted by the motebit (or a plan engine) in service of a goal. Examples: "search flights," "GET /api/latency," "call `gh pr list --assignee @me`."

Goals are **what**. Tasks are **how**. The agentic-AI literature is consistent on this; the motebit follows it.

## Why the motebit uses Goal as the primitive

The user's mental model is outcomes, not steps. A user who says "run this every morning" has declared a goal with a recurring cadence, not a scheduled task. A user who says "figure out X" has declared a goal with plan-decomposition strategy, not a one-shot task. Treating both as tasks forces the user to think in the motebit's execution terms, which inverts the relationship.

A goal has:

- `prompt` — the outcome, in the user's own words
- `cadence` — `once` | `hourly` | `daily` | `weekly` (how often the motebit pursues it)
- `strategy` — `simple` | `plan` (one-shot turn vs. plan decomposition)
- `status` — `pending` | `running` | `completed` | `failed` | `paused` (lifecycle)

Tasks are emergent. They exist as artifacts of a single goal run — the plan engine's steps for a `plan`-strategy goal, or the single invocation for a `simple`-strategy goal. Tasks are not first-class scheduled entities; they're owned by the goal run that spawned them, and their retention is the run record's retention.

## What this replaces

Before this doctrine, the motebit shipped two distinct scheduled-work primitives:

- **Goals** (web panel) — one-shot plan execution via `executeGoal(prompt)`, streaming `PlanChunk`.
- **Scheduled agents** (workstation) — recurring simple execution via `sendMessageStreaming(prompt)` on cadence.

Both were user-declared outcomes. The two names encoded an implementation detail (plan engine vs. simple turn) as if it were a product distinction. The product distinction is cadence and strategy; the name is always goal.

"Scheduled agent" in particular conflated the mechanism (scheduler) with the thing scheduled (a goal). The user doesn't schedule agents. The user declares a goal that recurs.

## How to apply

Three rules for any new feature that looks like scheduled work:

1. **If the user declares what they want, it's a goal.** Name it Goal. Model the cadence and strategy as attributes, not as separate primitives.
2. **If the motebit emits a step to serve a goal, it's a task.** Tasks are ephemeral, run-scoped, and anonymous to the user unless the plan progress view surfaces them.
3. **The primitive's lifecycle belongs to the goal.** Pause / resume / delete act on the goal; task state is a projection of the current or last run.

When a feature's naming is ambiguous — "is this a goal or a task?" — ask who declared it. User → goal. Motebit → task.

## Cross-references

- `packages/panels/CLAUDE.md` — the controller home for the Goals family
- [`records-vs-acts.md`](records-vs-acts.md) — the broader category rule; a goal is a record until the motebit pursues it, at which point the pursuit is an act
