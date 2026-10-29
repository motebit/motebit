/**
 * One law, two judges: the repo-task run's authority check
 * (`checkRepoTaskAuthority`) and the published verifier (`verifyRepoChange`)
 * must agree on every rule that can be judged before a change exists — on the
 * same scope, grant, tick, revocations, pins and clock, honest and tampered.
 *
 * For each fixture an honest bundle is built around the authority under test
 * (two tool receipts and an execution receipt signed by the agent over a
 * truthful change record), so the only rules either judge can fail are the
 * authority's. The comparison is by repair code, on the codes the run can
 * judge: every authority code except the ones about the change itself, the
 * three pin rules, the signature / binding / canonicality integrity codes,
 * and the two revocation codes. The run must fail exactly the rules the
 * verifier fails — no rule the run waves through, none it invents.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalSha256,
  hash,
  signDelegationRevocation,
  signExecutionReceipt,
  signToolInvocationReceipt,
} from "@motebit/crypto";
import type { KeyPair, StandingDelegation } from "@motebit/crypto";
import type { RepoChangeRepairCode } from "@motebit/protocol";
import { verifyRepoChange } from "@motebit/verifier";

import { InMemoryToolReceiptSink } from "../tool-receipt-sink.js";
import { checkRepoTaskAuthority, runRepoTask } from "../repo-task/index.js";
import type { RepoTaskAuthorityBundle, RepoTaskPin } from "../repo-task/index.js";
import {
  agentA,
  A_ID,
  call,
  F_ID,
  hex,
  HOUR,
  ids,
  keys,
  makeBundle,
  MemTree,
  MemWriter,
  REPO,
  revokeGrant,
  scriptedModel,
  T0,
  type BundleOpts,
} from "./repo-task-fixtures.js";

const enc = new TextEncoder();
const sha = (value: string) => ({ algorithm: "sha-256" as const, value });

/** The codes a run can judge before any change exists. */
const JUDGEABLE: ReadonlySet<RepoChangeRepairCode> = new Set<RepoChangeRepairCode>([
  "integrity.repo_change.bundle_malformed",
  "integrity.repo_change.value_not_canonical",
  "integrity.repo_change.signature_invalid",
  "integrity.repo_change.scope_binding_mismatch",
  "identity.repo_change.delegator_not_principal",
  "identity.repo_change.delegate_not_agent",
  "identity.repo_change.delegator_is_delegate",
  "identity.repo_change.signer_not_delegate",
  "authority.repo_change.tick_expired",
  "authority.repo_change.tick_not_yet_valid",
  "authority.repo_change.tick_insufficient",
  "authority.repo_change.tick_outlives_grant",
  "authority.repo_change.time_unavailable",
  "authority.repo_change.subject_binding_absent",
  "authority.repo_change.subject_binding_wrong_schema",
  "authority.repo_change.subject_wrong",
  "authority.repo_change.scope_tools_outside",
  "authority.repo_change.lifetime_exceeded",
  "authority.repo_change.spend_ceiling_present",
  "authority.repo_change.cadence_below_lifetime",
  "authority.repo_change.repo_mismatch",
  "authority.repo_change.grant_spent",
  "authority.repo_change.scope_path_not_permitted",
  "authority.repo_change.grant_not_yet_valid",
  "authority.repo_change.window_inverted",
  "authority.repo_change.tick_predates_grant",
  "revocation.repo_change.revoked",
  "revocation.repo_change.set_malformed",
]);

function gitBlobId(text: string): string {
  const body = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest("hex");
}

/** The verifier's verdict on an honest bundle built around `authority`, judged at `now`. */
async function verifierCodes(
  authority: RepoTaskAuthorityBundle,
  agent: RepoTaskPin,
  agentKey: { privateKey: Uint8Array; publicKey: Uint8Array },
  now: number,
  all = false,
): Promise<Set<RepoChangeRepairCode>> {
  const { scope, grant, tick } = authority;
  const taskId = "task-agree";
  const content = "the typo\n";
  const blob = gitBlobId(content);
  const toolReceipts = [];
  for (const [i, tool] of (["repo_read_blob", "repo_write_path"] as const).entries()) {
    toolReceipts.push(
      await signToolInvocationReceipt(
        {
          invocation_id: `inv-${i}`,
          task_id: taskId,
          motebit_id: agent.motebit_id,
          public_key: agent.public_key,
          device_id: "dev-a",
          tool_name: tool,
          started_at: T0 + 60_000,
          completed_at: T0 + 60_000,
          status: "completed",
          args_hash: "a".repeat(64),
          result_hash: "b".repeat(64),
          invocation_origin: "ai-loop",
        },
        agentKey.privateKey,
      ),
    );
  }
  const record = {
    spec: "motebit/repo-change@1.0" as const,
    grant_id: grant.grant_id,
    grant_digest: sha(await canonicalSha256(grant)),
    tick_digest: sha(await canonicalSha256(tick)),
    scope_digest: sha(await canonicalSha256(scope)),
    repo: scope.repo,
    object_format: scope.object_format,
    parent_commit: "1".repeat(40),
    head_commit: "2".repeat(40),
    entries: [{ path: "docs/a.md", mode: "100644", blob }],
    tool_receipt_digests: await Promise.all(
      toolReceipts.map(async (t) => sha(await canonicalSha256(t))),
    ),
    system_prompt_digest: sha("e".repeat(64)),
    provider: "scripted",
    model: "model-1",
    runtime_version: "9.9.9",
  };
  const result = canonicalJson(record);
  const receipt = await signExecutionReceipt(
    {
      task_id: taskId,
      motebit_id: agent.motebit_id,
      public_key: agent.public_key,
      device_id: "dev-a",
      submitted_at: T0 + 60_000,
      completed_at: T0 + 120_000,
      status: "completed",
      result,
      tools_used: ["repo_read_blob", "repo_write_path"],
      memories_formed: 0,
      prompt_hash: await hash(enc.encode(scope.task)),
      result_hash: await hash(enc.encode(result)),
      delegated_scope: tick.scope,
      invocation_origin: "ai-loop",
    },
    agentKey.privateKey,
  );
  const bundle = {
    spec: "motebit/repo-change-bundle@1.0",
    scope,
    grant,
    tick,
    tool_receipts: toolReceipts,
    receipt,
  };
  const verification = await verifyRepoChange({
    bundle: enc.encode(canonicalJson(bundle)),
    entries: [
      {
        kind: "modify",
        path: enc.encode("docs/a.md"),
        mode: "100644",
        previousMode: "100644",
        blob,
        containsNul: false,
      },
    ],
    trackedPaths: [enc.encode("docs/a.md")],
    pins: { principal: authority.principal, agents: authority.agents },
    isPathPermitted: authority.isPathPermitted,
    revocations: {
      set: authority.revocations.set,
      failures: authority.revocations.failures,
      freshness: { basis: "asserted", asOf: {} },
    },
    spent: authority.spent,
    expectedRepo: authority.expectedRepo,
    mode: { kind: "pull_request", shapeFailures: [], now },
  });
  return new Set(
    verification.diagnostics.failures.map((f) => f.code).filter((c) => all || JUDGEABLE.has(c)),
  );
}

async function runtimeCodes(
  authority: RepoTaskAuthorityBundle,
  agent: RepoTaskPin,
  now: number,
): Promise<Set<RepoChangeRepairCode>> {
  const check = await checkRepoTaskAuthority(authority, agent, now);
  return new Set(check.ok ? [] : check.failures.map((f) => f.code).filter((c) => JUDGEABLE.has(c)));
}

const NOW = T0 + 60_000;

/** A revocation of `grantId` claiming the grant's delegator, signed by `signer`, with extra fields. */
async function revocation(
  grant: StandingDelegation,
  signer: KeyPair,
  over: { grant_id?: string; extra?: Record<string, unknown> } = {},
) {
  return signDelegationRevocation(
    {
      grant_id: over.grant_id ?? grant.grant_id,
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      revoked_at: T0 + 1,
      ...(over.extra ?? {}),
    },
    signer.privateKey,
  );
}

const CASES: Array<[string, BundleOpts, number]> = [
  ["an honest authority (positive control)", {}, NOW],
  [
    "an extra signed key on the grant",
    { grant: (g) => void ((g as unknown as Record<string, unknown>).extra = "x") },
    NOW,
  ],
  [
    "a grant missing its not_before key",
    { grant: (g) => void delete (g as unknown as Record<string, unknown>).not_before },
    NOW,
  ],
  [
    "an extra signed key on the tick",
    { tick: (t) => void ((t as unknown as Record<string, unknown>).extra = "x") },
    NOW,
  ],
  ["an expired tick", {}, T0 + HOUR + 1],
  ["an expired grant", {}, T0 + 25 * HOUR],
  ["a tick not yet valid", { tick: (t) => void (t.not_before = T0 + 30 * 60_000) }, NOW],
  ["a grant not yet active", { grant: (g) => void (g.not_before = T0 + 30 * 60_000) }, NOW],
  [
    "a tick of another grant",
    { tick: (t) => void (t.grant_id = "ffffffff-4f50-4a61-8b72-93a4b5c6d7e8") },
    NOW,
  ],
  [
    "a tick whose signature does not verify",
    { tickSigned: (t) => void (t.scope = "repo_read_blob") },
    NOW,
  ],
  ["a tick signed by another key", { tickSigner: (k) => k.x }, NOW],
  ["a grant signed by another key", { grantSigner: (k) => k.x }, NOW],
  ["a tick with another delegate", { tick: (t) => void (t.delegate_id = "someone-else") }, NOW],
  ["a tick wider than the grant", { grant: (g) => void (g.scope = "repo_read_blob") }, NOW],
  ["a tick outliving the grant", { tick: (t) => void (t.expires_at = T0 + 25 * HOUR) }, NOW],
  ["a tick TTL beyond max_token_ttl_ms", { grant: (g) => void (g.max_token_ttl_ms = 1000) }, NOW],
  ["a tick issued before the grant", { tick: (t) => void (t.issued_at = T0 - 1) }, NOW],
  [
    "a scope wider than the two tools",
    {
      grant: (g) => void (g.scope = "repo_read_blob,repo_write_path,web_search"),
      tick: (t) => void (t.scope = "repo_read_blob,repo_write_path,web_search"),
    },
    NOW,
  ],
  [
    "a scope the grant does not bind",
    { scopeAfterBinding: (s) => void (s.task = "Something else.") },
    NOW,
  ],
  ["a grant with no subject_binding", { grant: (g) => void delete g.subject_binding }, NOW],
  [
    "a binding of another artifact schema",
    {
      grant: (g) => {
        if (g.subject_binding)
          g.subject_binding = { ...g.subject_binding, artifact_schema: "other.v1" };
      },
    },
    NOW,
  ],
  ["a grant for another subject", { grant: (g) => void (g.subject = "money") }, NOW],
  [
    "a grant with a spend ceiling",
    { grant: (g) => void (g.spend_ceiling = { amount_micro: 1, currency: "USD" } as never) },
    NOW,
  ],
  [
    "a grant living longer than 24 hours",
    { grant: (g) => void ((g.expires_at = T0 + 25 * HOUR), (g.cadence_ms = 25 * HOUR)) },
    NOW,
  ],
  ["a cadence below the lifetime", { grant: (g) => void (g.cadence_ms = HOUR) }, NOW],
  ["a grant whose window is inverted", { grant: (g) => void (g.not_before = T0 + 30 * HOUR) }, NOW],
  [
    "a delegator that is not the principal pin",
    { principal: (k) => ({ motebit_id: F_ID, public_key: hex(k.x) }) },
    NOW,
  ],
  ["a revoked grant", { revocations: async (k, g) => [await revokeGrant(k, g)] }, NOW],
  ["a spent grant", { spent: true }, NOW],
  [
    "an agent not pinned (another key under its id)",
    { agents: (k) => [{ motebit_id: A_ID, public_key: hex(k.x) }] },
    NOW,
  ],
  ["no agent pins at all", { agents: () => [] }, NOW],
  [
    "the agent pinned beside others (positive control)",
    {
      agents: (k) => [
        { motebit_id: "someone", public_key: hex(k.x) },
        { motebit_id: A_ID, public_key: hex(k.a) },
      ],
    },
    NOW,
  ],
  [
    "a forged-signature revocation of this grant",
    { revocations: async (k, g) => [await revocation(g, k.x)] },
    NOW,
  ],
  [
    "a revocation with an uppercase grant_id",
    {
      revocations: async (k, g) => [
        await revocation(g, k.f, { grant_id: g.grant_id.toUpperCase() }),
      ],
    },
    NOW,
  ],
  [
    "a revocation with an extra key",
    { revocations: async (k, g) => [await revocation(g, k.f, { extra: { reason: "x" } })] },
    NOW,
  ],
  [
    "a bad-signature revocation of another grant",
    {
      revocations: async (k, g) => [
        await revocation(g, k.x, { grant_id: "ffffffff-4f50-4a61-8b72-93a4b5c6d7e8" }),
      ],
    },
    NOW,
  ],
  [
    "a non-canonical subject_binding digest",
    {
      grant: (g) => {
        if (g.subject_binding)
          g.subject_binding = {
            ...g.subject_binding,
            digest: g.subject_binding.digest.toUpperCase(),
          };
      },
    },
    NOW,
  ],
  ["a revocation file that failed strict parsing", { revocationFailures: ["bad.json"] }, NOW],
  ["an allowed path the predicate refuses", { isPathPermitted: () => false }, NOW],
  ["a scope for another repository", { scope: (s) => void (s.repo = "someone/else") }, NOW],
  [
    "a non-canonical allowed path",
    { scope: (s) => void (s.allowed_paths = ["docs/a.md", "docs/../b.md"]) },
    NOW,
  ],
];

describe("repo task: the run and the verifier judge authority by one law", () => {
  for (const [label, opts, now] of CASES) {
    it(`agree on ${label}`, async () => {
      const k = await keys();
      const agent = { motebit_id: A_ID, public_key: hex(k.a) };
      const authority = await makeBundle(opts);
      const fromVerifier = await verifierCodes(authority, agent, k.a, now);
      const fromRun = await runtimeCodes(authority, agent, now);
      expect([...fromRun].sort()).toEqual([...fromVerifier].sort());
      if (label.includes("positive control")) expect(fromRun.size).toBe(0);
      else expect(fromRun.size).toBeGreaterThan(0);
    });
  }

  it("agree on an agent that is not the grant's delegate", async () => {
    const k = await keys();
    const agent = { motebit_id: A_ID, public_key: hex(k.x) };
    const authority = await makeBundle();
    const fromVerifier = await verifierCodes(authority, agent, k.x, NOW);
    const fromRun = await runtimeCodes(authority, agent, NOW);
    expect([...fromRun].sort()).toEqual([...fromVerifier].sort());
    expect(fromRun.has("identity.repo_change.signer_not_delegate")).toBe(true);
  });

  it("agree when the delegator delegates to itself", async () => {
    const k = await keys();
    const authority = await makeBundle({
      grant: (g) => void ((g.delegate_id = F_ID), (g.delegate_public_key = hex(k.f))),
      tick: (t) => void ((t.delegate_id = F_ID), (t.delegate_public_key = hex(k.f))),
    });
    const agent = { motebit_id: F_ID, public_key: hex(k.f) };
    const fromVerifier = await verifierCodes(authority, agent, k.f, NOW);
    const fromRun = await runtimeCodes(authority, agent, NOW);
    expect([...fromRun].sort()).toEqual([...fromVerifier].sort());
    expect(fromRun.has("identity.repo_change.delegator_is_delegate")).toBe(true);
  });

  it("the honest bundle the comparison builds fully verifies (the harness is sound)", async () => {
    const k = await keys();
    const agent = { motebit_id: A_ID, public_key: hex(k.a) };
    const authority = await makeBundle();
    expect(authority.scope.repo).toBe(REPO);
    // Every rule, not only the judgeable ones: nothing but authority can fail.
    expect(await verifierCodes(authority, agent, k.a, NOW, true)).toEqual(new Set());
  });
});

describe("repo task: a call that names no tool leaves the bundle verifiable", () => {
  it("run -> bundle -> verifyRepoChange: the empty-name call is a denied placeholder, no failure", async () => {
    const k = await keys();
    const authority = await makeBundle();
    const { scope, grant, tick } = authority;
    const content = "the typo\n";
    const blob = gitBlobId(content);
    const result = await runRepoTask({
      authority,
      agent: await agentA(),
      provider: scriptedModel([
        [call("c0", "", { path: "docs/a.md" })],
        [call("c1", "repo_write_path", { path: "docs/a.md", content })],
        "done",
      ]),
      providerName: "scripted",
      reader: MemTree.withFile("docs/a.md", "teh typo\n"),
      stager: new MemWriter(),
      receipts: new InMemoryToolReceiptSink(),
      runtimeVersion: "9.9.9",
      clock: () => T0 + 60_000,
      newId: ids,
    });
    expect(result.tool_receipts.map((r) => [r.tool_name, r.status])).toEqual([
      ["repo_task_unnamed_tool", "denied"],
      ["repo_write_path", "completed"],
    ]);
    const record = {
      spec: "motebit/repo-change@1.0" as const,
      grant_id: grant.grant_id,
      grant_digest: sha(await canonicalSha256(grant)),
      tick_digest: sha(await canonicalSha256(tick)),
      scope_digest: sha(await canonicalSha256(scope)),
      repo: scope.repo,
      object_format: scope.object_format,
      parent_commit: "1".repeat(40),
      head_commit: "2".repeat(40),
      entries: [{ path: "docs/a.md", mode: "100644", blob }],
      tool_receipt_digests: await Promise.all(
        result.tool_receipts.map(async (t) => sha(await canonicalSha256(t))),
      ),
      system_prompt_digest: result.system_prompt_digest,
      provider: result.provider,
      model: result.model,
      runtime_version: result.runtime_version,
    };
    const text = canonicalJson(record);
    const receipt = await signExecutionReceipt(
      {
        task_id: result.task_id,
        motebit_id: A_ID,
        public_key: hex(k.a),
        device_id: "dev-a",
        submitted_at: result.submitted_at,
        completed_at: result.completed_at,
        status: "completed",
        result: text,
        tools_used: [...result.tools_used],
        memories_formed: result.memories_formed,
        prompt_hash: result.prompt_hash,
        result_hash: await hash(enc.encode(text)),
        delegated_scope: result.delegated_scope,
        invocation_origin: "ai-loop",
      },
      k.a.privateKey,
    );
    const bundle = {
      spec: "motebit/repo-change-bundle@1.0",
      scope,
      grant,
      tick,
      tool_receipts: result.tool_receipts,
      receipt,
    };
    const verification = await verifyRepoChange({
      bundle: enc.encode(canonicalJson(bundle)),
      entries: [
        {
          kind: "modify",
          path: enc.encode("docs/a.md"),
          mode: "100644",
          previousMode: "100644",
          blob,
          containsNul: false,
        },
      ],
      trackedPaths: [enc.encode("docs/a.md")],
      pins: { principal: authority.principal, agents: authority.agents },
      isPathPermitted: authority.isPathPermitted,
      revocations: {
        set: authority.revocations.set,
        failures: authority.revocations.failures,
        freshness: { basis: "asserted", asOf: {} },
      },
      spent: authority.spent,
      expectedRepo: authority.expectedRepo,
      mode: { kind: "pull_request", shapeFailures: [], now: T0 + 120_000 },
    });
    expect(verification.diagnostics.failures.map((f) => f.code)).toEqual([]);
  });
});
