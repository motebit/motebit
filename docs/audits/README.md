# Audits

**Procedure:** Repo Constitutional Audit **v1.1**.
**Canonical source:** the shared standards repo, `repo-constitutional-audit/versions/v1.1.md` (local `~/src/standards`, commit `f7008be`; not yet published).

This file is a thin adapter. It adds Motebit's specifics and points at existing authority; it restates none of it ([`readme-as-glass`](../doctrine/readme-as-glass.md)). It may ADD questions. It never weakens the procedure's evidence or adversarial-review requirements.

## Authority, in order

| #   | Source                                                                                                                                  | Role                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | [`CLAUDE.md`](../../CLAUDE.md) (top) + [`DOCTRINE.md`](../../DOCTRINE.md)                                                               | Thesis + the derivation chain everything traces to                                      |
| 2   | [`CONSTITUTION.md`](../../CONSTITUTION.md)                                                                                              | One being, surfaces, consent, open-standard / proprietary-product split                 |
| 3   | [`protocol-primacy`](../doctrine/protocol-primacy.md)                                                                                   | Protocol with a company on top; the protocol-first audit                                |
| 4   | [`clearing-house-not-thin-waist`](../doctrine/clearing-house-not-thin-waist.md)                                                         | Relay/settlement is the business on top of the protocol — the responsibility is settled |
| 5   | [`receipts-unified`](../doctrine/receipts-unified.md)                                                                                   | One receipt family, one verification path                                               |
| 6   | [`atom-loop-occupant`](../doctrine/atom-loop-occupant.md)                                                                               | The generating predicate; its own conservation audit                                    |
| 7   | [`agentic-era-engineering`](../doctrine/agentic-era-engineering.md)                                                                     | Coherence as the scarce resource; gates teach                                           |
| 8   | [`composition-preserves-enforcement`](../doctrine/composition-preserves-enforcement.md)                                                 | Guarantees must survive composition into the deployed system                            |
| 9   | Remaining [`docs/doctrine/`](../doctrine/) (indexed in `CLAUDE.md`) + [`docs/proposals/`](../proposals/) (no separate ADR index exists) | Accepted and proposed decisions                                                         |

Code and tests are evidence of what exists; they never outrank the thesis or accepted doctrine. A cold reconstruction is still performed first, then reconciled against this table. Conflicts are marked **UNCERTAIN** for the founder, never silently resolved.

An accepted decision settles a **responsibility** (whether Motebit owns it), never its **implementation**. Do not re-litigate whether Motebit has a role that doctrine already assigns. Do audit how the repo realizes it: the correct boundary, and no more machinery than the responsibility needs.

## Product loop

Stated in [`CLAUDE.md`](../../CLAUDE.md) — "The three things no one else is building together" and the **Economic loop** principle — with value capture in [`clearing-house-not-thin-waist`](../doctrine/clearing-house-not-thin-waist.md). The audit evaluates architectural fidelity to that loop, not product demand.

## Layer taxonomy

Fixed across audits for comparability. Every workspace package (`pnpm-workspace.yaml`: `packages/*`, `apps/*`, `services/*`) has a **primary ownership layer**. Packages can be legitimately cross-cutting, so each audit record lists cross-layer dependencies explicitly; the taxonomy must not hide the coupling the audit exists to find. Where ownership itself is unclear, the package is **UNCERTAIN** (tentative placements are marked `(?)`).

| Layer                                          | Paths                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Protocol / crypto / identity (11)            | `packages/{protocol,sdk,crypto,crypto-android-keystore,crypto-appattest,crypto-tpm,crypto-webauthn,wire-schemas,encryption,core-identity,identity-file}`                                                                                                                                                        |
| 2 Runtime / delegation / execution (24)        | `packages/{runtime,runtime-host,ai-core,planner,policy,policy-invariants,privacy-layer,memory-graph,event-log,reflection,gradient(?),state-vector(?),semiring,tools,skills,self-knowledge,mcp-client,mcp-server,molecule-runner,persistence,browser-persistence,sqlite-migrations,sync-engine,circuit-breaker}` |
| 3 Relay / settlement / economic checkpoint (9) | `services/relay`, `packages/{relay-client,market(?),settlement-rails,virtual-accounts,wallet-solana,deposit-detector,evm-rpc,treasury-reconciliation}`                                                                                                                                                          |
| 4 Verification / receipts / evidence (4)       | `packages/{verifier,verify,state-export-client}`, `apps/verify`                                                                                                                                                                                                                                                 |
| 5 Operator / admin / surfaces (15)             | `apps/{cli,desktop,mobile,web,spatial,operator,inspector,identity,docs,vscode}`, `packages/{panels,surface-kit,render-engine,behavior-engine,voice}`                                                                                                                                                            |
| 6 Services / integrations / downstream (11)    | `services/{auditor,browser-sandbox,clerk,code-review,embed,proxy,read-url,research,summarize,web-search}`, `packages/create-motebit(?)`                                                                                                                                                                         |
| 7 Whole-system synthesis                       | All of the above, composed — catches composition failures the layer audits miss                                                                                                                                                                                                                                 |

**UNCERTAIN placements:** `gradient`, `state-vector` (self-model vs surface state, L2 vs L5); `market` (routing judgment vs economic checkpoint, L2 vs L3); `create-motebit` (Apache-2.0 floor vs downstream scaffold, L1 vs L6). `packages/github-action` is not a workspace package (no `package.json`); audit it with Layer 4.

## Motebit questions

In addition to the procedure's questions (v1.1 already covers guards, claims vs proof and disclosure):

1. Has implementation convenience become protocol?
2. Are the protocol (Apache-2.0 permissive floor) and BSL runtime boundaries still clean?
3. Has economic settlement leaked into the protocol thin waist?
4. Are operator controls becoming product semantics?
5. Are receipts evidence, or merely telemetry?
6. Do agent-generated judgments ever outrank deterministic gates or external reality?
7. Has a demo/reference experience leaked into a primitive?
8. Does each subsystem exist because Motebit itself must own it, rather than a downstream app, marketplace or workflow product?
9. Are there duplicated authorities or sources of truth?
10. Is any historical experiment or compatibility path kept only because it exists?

## Execution rules

- Every audit pins an exact commit SHA as its evidence boundary. Development may continue; the record states what it evaluated.
- Layer audits are read-only. A whole-system synthesis pass (Layer 7) follows them.
- Every consequential MOVE / EXTRACT / DELETE / SIMPLIFY requires a separate cold **DEFENDER** pass arguing the strongest preservation case before acceptance (procedure step 5).
- Agreement between agents is judgment, not guarantee. Label every finding as judgment or deterministic evidence.
- The canonical procedure is not reachable from cloud lanes (`~/src/standards` has no remote). Every audit lane is given the exact v1.1 text verbatim in its brief.

## Evidence sources

Operational pointers, not doctrine:

- Repo + git history — agents.
- `pnpm check` drift gates ([`drift-defenses.md`](../drift-defenses.md)) and CI — deterministic evidence.
- Production relay state — founder-run read access only; no agent prod access.
- Published npm packages + [`spec/`](../../spec/) — external contracts.

## When an audit is required

Before a major architectural phase, or a material change to the protocol, authority boundaries, money paths, persistent state, or a major subsystem. Record the decision and its reason either way. The stabilization-freeze technical exit requires a clean adversarial pass.

## Records

Audit records are **private by default** (procedure, "Where records live"). They are not committed to
this public repository. Records live in the private cross-repo audit store `hakimlabs/audits` under
`motebit/`, named `YYYY-MM-DD-<scope>.md`. Only durable results (fixes, guards, public contracts)
land here, through ordinary changes.

Every record opens with its provenance. A record that does not name the procedure copy it used makes
no claim of compliance with v1.1. Every record also carries the procedure's required outputs,
including the survival rate, guards exercised by failure versus taken on trust, claims that exceed
their proof, and disclosures the product contract does not require.

```text
Procedure: Repo Constitutional Audit v1.1
Canonical commit: f7008be
Execution copy: procedure text supplied verbatim in the audit brief
Evidence boundary: <motebit commit SHA>
```

Pre-procedure audits in [`docs/doctrine/audits/`](../doctrine/audits/) are historical context only.
