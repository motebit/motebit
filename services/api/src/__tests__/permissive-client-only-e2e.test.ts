/**
 * Permissive-floor-only client proof — the open-protocol claim made mechanical.
 *
 * Motebit's thesis splits the world into permissive-floor "protocol"
 * packages (Apache-2.0: `@motebit/protocol`, `@motebit/crypto`,
 * `@motebit/sdk`, `@motebit/verifier`, the four `@motebit/crypto-*`
 * platform-attestation leaves, `create-motebit`, and the GitHub Action)
 * and BSL "reference implementation" packages (everything else). The
 * claim in README.md, CLAUDE.md, and LICENSING.md is that a competing
 * relay or a third-party client can interoperate with Motebit using
 * only the permissive-floor surface — no BSL code, no proprietary
 * bindings, no hidden invariants.
 *
 * `check-spec-permissive-boundary` enforces the claim at the spec level
 * (every backticked callable in `spec/*.md` resolves to a permissive-
 * floor-exported symbol or an explicit waiver). `check-deps` enforces
 * the claim at the import graph (permissive-floor packages must not
 * import from BSL). This file is the *runtime* proof: an end-to-end
 * signed-receipt delegation round trip where the client code — keygen,
 * token minting, receipt construction, signing, submission, and offline
 * verification — imports ONLY from `@motebit/crypto` and `@motebit/sdk`.
 * No `@motebit/encryption`, no `@motebit/mcp-client`, no `@motebit/runtime`,
 * no BSL helpers of any kind.
 *
 * The server is Motebit's own BSL relay (`createTestRelay`) — a
 * third-party relay implementation would stand in for it at the same
 * wire interface. We prove the *client* surface is self-sufficient;
 * the server side is the reference implementation by definition.
 *
 * If this test fails because a primitive is missing from `@motebit/crypto`
 * or `@motebit/sdk`, that is a real doctrine gap — the permissive-floor
 * surface has silently diverged from the reference and must be closed.
 */
import { describe, it, expect, beforeEach } from "vitest";

// ── Permissive-floor-only client imports ───────────────────────────
// Everything the test uses as an "external client" comes from these
// two permissive-floor (Apache-2.0) packages. Adding a BSL import
// here would defeat the proof.
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  canonicalJson,
  hash,
  signExecutionReceipt,
  verifyExecutionReceipt,
  createSignedToken,
} from "@motebit/crypto";
import type { CitedAnswer, Citation, DeviceId, ExecutionReceipt, MotebitId } from "@motebit/sdk";

// ── BSL test infrastructure — server only ───────────────────────────
// These are used to spin up Motebit's reference relay as the server
// under test. The client portion of the test (below) does not touch
// any BSL symbol from these imports.
import {
  createTestRelay,
  createAgent,
  JSON_AUTH,
  AUTH_HEADER as AUTH,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

describe("Permissive-floor-only client — open-protocol proof", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("constructs, signs, submits, and verifies a full delegation receipt using only @motebit/crypto + @motebit/sdk", async () => {
    // ── Client step 1: generate a keypair ──────────────────────────
    // `generateKeypair` is a permissive-floor primitive. An external
    // implementation using any standards-compliant Ed25519 library would
    // be equivalent.
    const kpDelegator = await generateKeypair();
    const kpWorker = await generateKeypair();

    // ── Server bootstrap: register both agents so the relay knows them ──
    const delegator = await createAgent(relay, bytesToHex(kpDelegator.publicKey));
    const worker = await createAgent(relay, bytesToHex(kpWorker.publicKey));

    // Register the worker as a service provider. No permissive-floor constraint
    // here — this is the relay's admin API, which is outside the "external client"
    // boundary being proven. A competing relay would expose its own shape.
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: worker.motebitId,
        endpoint_url: "http://localhost:3200/mcp",
        capabilities: ["web_search"],
      }),
    });
    await relay.app.request(`/api/v1/agents/${worker.motebitId}/listing`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        capabilities: ["web_search"],
        pricing: [{ capability: "web_search", unit_cost: 0.5, currency: "USD", per: "task" }],
        sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
        description: "External-client-test worker",
        pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    });
    await relay.app.request(`/api/v1/agents/${delegator.motebitId}/deposit`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 10.0,
        reference: `deposit-${crypto.randomUUID()}`,
        description: "test",
      }),
    });

    // ── Client step 2: submit a task ───────────────────────────────
    // The client POSTs a delegation request. Wire format is documented in
    // spec/delegation-v1.md; no BSL code required to construct the JSON.
    const submitRes = await relay.app.request(`/agent/${worker.motebitId}/task`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        prompt: "mit-only client: search for motebit",
        submitted_by: delegator.motebitId,
        required_capabilities: ["web_search"],
      }),
    });
    expect(submitRes.status).toBe(201);
    const { task_id: taskId } = (await submitRes.json()) as { task_id: string };

    // ── Client step 3: construct + sign an ExecutionReceipt ────────
    // Every field named in spec/execution-ledger-v1.md's Wire format
    // section. signExecutionReceipt canonicalizes the payload, hashes
    // with SHA-256, signs with Ed25519, and returns the `suite`-tagged
    // artifact. All three steps are in @motebit/crypto.
    const enc = new TextEncoder();
    const signed = await signExecutionReceipt(
      {
        task_id: taskId,
        relay_task_id: taskId,
        motebit_id: worker.motebitId as unknown as MotebitId,
        public_key: bytesToHex(kpWorker.publicKey),
        device_id: "mit-worker-device" as unknown as DeviceId,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "open-protocol proof succeeded",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: await hash(enc.encode("mit-only client: search for motebit")),
        result_hash: await hash(enc.encode("open-protocol proof succeeded")),
      },
      kpWorker.privateKey,
      kpWorker.publicKey,
    );

    // Cryptosuite pin: every signed artifact must carry a SuiteId value.
    // The permissive-floor surface's `signExecutionReceipt` picks the canonical one.
    expect(signed.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(typeof signed.signature).toBe("string");
    expect(signed.public_key).toBe(bytesToHex(kpWorker.publicKey));

    // ── Client step 4: submit the signed receipt ───────────────────
    const resultRes = await relay.app.request(`/agent/${worker.motebitId}/task/${taskId}/result`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(signed),
    });
    expect(resultRes.status).toBe(200);

    // ── Client step 5: fetch the archived receipt + offline-verify ─
    // Rule 11 of services/api/CLAUDE.md: relay_receipts.receipt_json is
    // append-only and byte-identical. The admin endpoint returns the
    // canonical JSON as the response body verbatim — no wrapper, no
    // re-serialization. An auditor with just this HTTP response and the
    // signer's public key can reproduce the verification.
    const fetchRes = await relay.app.request(
      `/api/v1/admin/receipts/${worker.motebitId}/${taskId}`,
      { headers: AUTH },
    );
    expect(fetchRes.status).toBe(200);
    const servedBytes = await fetchRes.text();

    // Byte-identical persistence check — same canonical JSON the worker
    // signed, same signature, same suite. If the relay re-serialized the
    // payload, the signature would break.
    expect(servedBytes).toBe(canonicalJson(signed));

    // ── Client step 6: verify offline with @motebit/crypto alone ───
    // Parse the stored canonical JSON, load the signer's public key from
    // the receipt itself, verify the Ed25519 signature over the canonical
    // hash. An auditor in a different process, written by a different
    // organization, using only the permissive-floor surface, reproduces this check.
    const parsed = JSON.parse(servedBytes) as typeof signed;
    const pubKeyBytes = hexToBytes(parsed.public_key);
    const ok = await verifyExecutionReceipt(parsed, pubKeyBytes);
    expect(ok).toBe(true);

    // Negative control — a tampered field breaks verification.
    const tampered = { ...parsed, result: "tampered" };
    const notOk = await verifyExecutionReceipt(tampered, pubKeyBytes);
    expect(notOk).toBe(false);
  });

  it("verifies a CitedAnswer using only permissive-floor surface (protocol types + crypto)", async () => {
    // The three-tier answer engine emits CitedAnswer. This test proves
    // that an auditor can reconstruct the verification using only
    // `@motebit/protocol` types and `@motebit/crypto` primitives — no BSL
    // research-service code, no McpClientAdapter. The shape is the
    // open-protocol commitment.
    const kpResearch = await generateKeypair();
    const kpAtom = await generateKeypair();

    const enc = new TextEncoder();

    // A web atom (e.g., read-url service) signs its own atom-level receipt
    // declaring "I fetched this URL; here is what it said."
    const atomTaskId = "atom-task-abc";
    const atomReceipt = await signExecutionReceipt(
      {
        task_id: atomTaskId,
        relay_task_id: atomTaskId,
        motebit_id: "atom-motebit" as unknown as MotebitId,
        public_key: bytesToHex(kpAtom.publicKey),
        device_id: "atom-device" as unknown as DeviceId,
        submitted_at: Date.now() - 2000,
        completed_at: Date.now() - 1000,
        status: "completed" as const,
        result: "The page says Motebit is an open protocol for sovereign AI agents.",
        tools_used: ["read_url"],
        memories_formed: 0,
        prompt_hash: await hash(enc.encode("https://motebit.com")),
        result_hash: await hash(enc.encode("page-content")),
      },
      kpAtom.privateKey,
      kpAtom.publicKey,
    );

    // The research motebit assembles its outer receipt, carrying the atom
    // receipt in its delegation chain.
    const outerTaskId = "outer-answer-1";
    const outerReceipt = await signExecutionReceipt(
      {
        task_id: outerTaskId,
        relay_task_id: outerTaskId,
        motebit_id: "research-motebit" as unknown as MotebitId,
        public_key: bytesToHex(kpResearch.publicKey),
        device_id: "research-device" as unknown as DeviceId,
        submitted_at: Date.now() - 3000,
        completed_at: Date.now(),
        status: "completed" as const,
        result: "synthesized answer",
        tools_used: ["research"],
        memories_formed: 0,
        prompt_hash: await hash(enc.encode("what is Motebit")),
        result_hash: await hash(enc.encode("synthesized")),
        delegation_receipts: [atomReceipt as unknown as ExecutionReceipt],
      },
      kpResearch.privateKey,
      kpResearch.publicKey,
    );

    // The CitedAnswer carries one interior citation (no receipt) and one
    // web citation (bound to the atom receipt by task_id).
    const interiorCitation: Citation = {
      text_excerpt: "Motebit is an open protocol for sovereign AI agents.",
      source: "interior",
      locator: "README.md#Motebit",
    };
    const webCitation: Citation = {
      text_excerpt: atomReceipt.result,
      source: "web",
      locator: "https://motebit.com",
      receipt_task_id: atomTaskId,
    };
    const answer: CitedAnswer = {
      answer: "Motebit is an open protocol for sovereign AI agents [1][2].",
      citations: [interiorCitation, webCitation],
      receipt: outerReceipt as unknown as ExecutionReceipt,
    };

    // Permissive-floor-only verification path —
    // 1. The outer receipt verifies against the research motebit's key.
    const outerOk = await verifyExecutionReceipt(answer.receipt, kpResearch.publicKey);
    expect(outerOk).toBe(true);

    // 2. Every web citation binds to a receipt in the outer's delegation
    //    chain; that atom receipt verifies against its own signer's key.
    for (const citation of answer.citations) {
      if (citation.source !== "web") continue;
      const bound = (answer.receipt.delegation_receipts ?? []).find(
        (r) => r.task_id === citation.receipt_task_id,
      );
      expect(bound).toBeDefined();
      const atomOk = await verifyExecutionReceipt(bound!, kpAtom.publicKey);
      expect(atomOk).toBe(true);
    }

    // 3. Interior citations are self-attested; a verifier cross-checks the
    //    locator pattern and trusts the motebit's committed corpus hash
    //    out-of-band. There is nothing to verify cryptographically here
    //    — that is the point of the source tier.
    const interiorCount = answer.citations.filter((c) => c.source === "interior").length;
    expect(interiorCount).toBe(1);

    // 4. Negative control — tampering the outer's answer text breaks the
    //    outer signature since the consumer SHOULD embed a hash over the
    //    cited portion. The protocol today signs the receipt, not the
    //    free-text answer, so the answer is trust-on-first-render for the
    //    caller — but the citations and their receipts are signed.
    const tamperedOuter = {
      ...answer.receipt,
      result: "tampered synthesis",
    } as ExecutionReceipt;
    const tamperedOk = await verifyExecutionReceipt(tamperedOuter, kpResearch.publicKey);
    expect(tamperedOk).toBe(false);
  });

  it("mints a signed bearer token using only the permissive-floor createSignedToken primitive", async () => {
    // Signed bearer tokens (spec/auth-token-v1.md) are the relay's auth
    // primitive. An external client mints them with `createSignedToken`
    // — audience binding, suite tag, Ed25519 signature — no BSL required.
    const kp = await generateKeypair();

    const now = Date.now();
    const token = await createSignedToken(
      {
        mid: "client-mit-proof",
        did: "client-device",
        aud: "task:submit",
        jti: crypto.randomUUID(),
        exp: now + 60_000,
        iat: now,
      },
      kp.privateKey,
    );

    // The motebit-jwt-ed25519-v1 suite produces a 2-part base64url
    // payload.signature shape (the suite tag lives inside the payload,
    // not in a separate header — see packages/crypto/src/signing.ts).
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // The payload is addressable and includes the suite tag so any
    // conforming parser can dispatch verification.
    const payloadB64 = token.split(".")[0];
    if (payloadB64 === undefined) throw new Error("malformed token");
    const decoded = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { aud: string; mid: string; suite: string };
    expect(decoded.aud).toBe("task:submit");
    expect(decoded.mid).toBe("client-mit-proof");
    expect(decoded.suite).toBe("motebit-jwt-ed25519-v1");
  });
});
