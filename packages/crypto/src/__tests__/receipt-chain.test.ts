import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signExecutionReceipt,
  verifyExecutionReceipt,
  verifyReceiptSequence,
  signDelegation,
  verifyDelegation,
  verifyDelegationChain,
  toBase64Url,
  hash,
  type SignableReceipt,
  type DelegationToken,
  type ReceiptChainEntry,
} from "../index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceipt(
  overrides: Partial<Omit<SignableReceipt, "signature">> = {},
): Omit<SignableReceipt, "signature"> {
  return {
    task_id: "task-001",
    motebit_id: "mote-alice",
    device_id: "device-001",
    submitted_at: 1700000000000,
    completed_at: 1700000060000,
    status: "completed",
    result: "Task completed successfully",
    tools_used: ["web_search"],
    memories_formed: 1,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// verifyExecutionReceipt — additional coverage
// ---------------------------------------------------------------------------

describe("verifyExecutionReceipt", () => {
  it("valid single receipt verifies successfully", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("tampered receipt (modified result_hash) fails verification", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    const tampered: SignableReceipt = { ...signed, result_hash: "c".repeat(64) };
    const valid = await verifyExecutionReceipt(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("receipt with wrong public key fails", async () => {
    const kpSigner = await generateKeypair();
    const kpWrong = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kpSigner.privateKey);

    const valid = await verifyExecutionReceipt(signed, kpWrong.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyReceiptSequence
// ---------------------------------------------------------------------------

describe("verifyReceiptSequence", () => {
  it("empty chain returns valid", async () => {
    const result = await verifyReceiptSequence([]);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("single-receipt chain verifies", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    const chain: ReceiptChainEntry[] = [
      { receipt: signed, signer_public_key: kp.publicKey },
    ];
    const result = await verifyReceiptSequence(chain);
    expect(result.valid).toBe(true);
  });

  it("multi-receipt chain (A -> B -> C) verifies", async () => {
    const kpAlice = await generateKeypair();
    const kpWebSearch = await generateKeypair();
    const kpReadUrl = await generateKeypair();

    const signedAlice = await signExecutionReceipt(
      makeReceipt({
        task_id: "task-alice-001",
        motebit_id: "mote-alice",
        submitted_at: 1700000000000,
        completed_at: 1700000010000,
        result: "Delegated to web-search",
        tools_used: ["motebit_task"],
      }),
      kpAlice.privateKey,
    );

    const signedWebSearch = await signExecutionReceipt(
      makeReceipt({
        task_id: "task-ws-001",
        motebit_id: "mote-web-search",
        submitted_at: 1700000010000,
        completed_at: 1700000030000,
        result: "Search results found",
        tools_used: ["web_search", "motebit_task"],
      }),
      kpWebSearch.privateKey,
    );

    const signedReadUrl = await signExecutionReceipt(
      makeReceipt({
        task_id: "task-ru-001",
        motebit_id: "mote-read-url",
        submitted_at: 1700000030000,
        completed_at: 1700000050000,
        result: "Page content retrieved",
        tools_used: ["read_url"],
      }),
      kpReadUrl.privateKey,
    );

    const chain: ReceiptChainEntry[] = [
      { receipt: signedAlice, signer_public_key: kpAlice.publicKey },
      { receipt: signedWebSearch, signer_public_key: kpWebSearch.publicKey },
      { receipt: signedReadUrl, signer_public_key: kpReadUrl.publicKey },
    ];

    const result = await verifyReceiptSequence(chain);
    expect(result.valid).toBe(true);
  });

  it("chain with tampered middle receipt fails", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const signedA = await signExecutionReceipt(
      makeReceipt({ task_id: "a", submitted_at: 1000, completed_at: 2000 }),
      kpA.privateKey,
    );
    const signedB = await signExecutionReceipt(
      makeReceipt({ task_id: "b", submitted_at: 2000, completed_at: 3000 }),
      kpB.privateKey,
    );
    const signedC = await signExecutionReceipt(
      makeReceipt({ task_id: "c", submitted_at: 3000, completed_at: 4000 }),
      kpC.privateKey,
    );

    const tamperedB: SignableReceipt = { ...signedB, result: "TAMPERED" };

    const chain: ReceiptChainEntry[] = [
      { receipt: signedA, signer_public_key: kpA.publicKey },
      { receipt: tamperedB, signer_public_key: kpB.publicKey },
      { receipt: signedC, signer_public_key: kpC.publicKey },
    ];

    const result = await verifyReceiptSequence(chain);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Receipt 1");
    expect(result.index).toBe(1);
  });

  it("chain with out-of-order timestamps fails", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();

    const signedA = await signExecutionReceipt(
      makeReceipt({ task_id: "a", submitted_at: 1000, completed_at: 5000 }),
      kpA.privateKey,
    );
    const signedB = await signExecutionReceipt(
      makeReceipt({ task_id: "b", submitted_at: 3000, completed_at: 6000 }),
      kpB.privateKey,
    );

    const chain: ReceiptChainEntry[] = [
      { receipt: signedA, signer_public_key: kpA.publicKey },
      { receipt: signedB, signer_public_key: kpB.publicKey },
    ];

    const result = await verifyReceiptSequence(chain);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("submitted_at");
    expect(result.index).toBe(1);
  });

  it("chain with wrong signer public key fails at that index", async () => {
    const kpReal = await generateKeypair();
    const kpWrong = await generateKeypair();

    const signed = await signExecutionReceipt(
      makeReceipt({ task_id: "x" }),
      kpReal.privateKey,
    );

    const chain: ReceiptChainEntry[] = [
      { receipt: signed, signer_public_key: kpWrong.publicKey },
    ];

    const result = await verifyReceiptSequence(chain);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Receipt 0");
    expect(result.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyDelegationChain
// ---------------------------------------------------------------------------

describe("verifyDelegationChain", () => {
  async function makeDelegation(
    delegatorKp: { publicKey: Uint8Array; privateKey: Uint8Array },
    delegateKp: { publicKey: Uint8Array; privateKey: Uint8Array },
    delegatorId: string,
    delegateId: string,
    scope: string = "web_search",
  ): Promise<DelegationToken> {
    const body: Omit<DelegationToken, "signature"> = {
      delegator_id: delegatorId,
      delegator_public_key: toBase64Url(delegatorKp.publicKey),
      delegate_id: delegateId,
      delegate_public_key: toBase64Url(delegateKp.publicKey),
      scope,
      issued_at: Date.now(),
      expires_at: Date.now() + 3600_000,
    };
    return signDelegation(body, delegatorKp.privateKey);
  }

  it("empty delegation chain returns valid", async () => {
    const result = await verifyDelegationChain([]);
    expect(result.valid).toBe(true);
  });

  it("single valid delegation verifies", async () => {
    const kpAlice = await generateKeypair();
    const kpService = await generateKeypair();

    const delegation = await makeDelegation(
      kpAlice, kpService, "mote-alice", "mote-web-search",
    );

    const result = await verifyDelegationChain([delegation]);
    expect(result.valid).toBe(true);
  });

  it("multi-hop delegation chain verifies (Alice -> B -> C)", async () => {
    const kpAlice = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const delegation1 = await makeDelegation(
      kpAlice, kpB, "mote-alice", "mote-service-b", "web_search",
    );
    const delegation2 = await makeDelegation(
      kpB, kpC, "mote-service-b", "mote-service-c", "read_url",
    );

    const result = await verifyDelegationChain([delegation1, delegation2]);
    expect(result.valid).toBe(true);
  });

  it("broken chain fails — delegate_id mismatch", async () => {
    const kpAlice = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const delegation1 = await makeDelegation(
      kpAlice, kpB, "mote-alice", "mote-service-b",
    );
    const delegation2 = await makeDelegation(
      kpB, kpC, "mote-service-WRONG", "mote-service-c",
    );

    const result = await verifyDelegationChain([delegation1, delegation2]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Chain break at 1");
    expect(result.error).toContain("delegate_id");
  });

  it("broken chain fails — public key mismatch", async () => {
    const kpAlice = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const kpBogus = await generateKeypair();

    const delegation1 = await makeDelegation(
      kpAlice, kpB, "mote-alice", "mote-service-b",
    );
    const body2: Omit<DelegationToken, "signature"> = {
      delegator_id: "mote-service-b",
      delegator_public_key: toBase64Url(kpBogus.publicKey),
      delegate_id: "mote-service-c",
      delegate_public_key: toBase64Url(kpC.publicKey),
      scope: "read_url",
      issued_at: Date.now(),
      expires_at: Date.now() + 3600_000,
    };
    const delegation2 = await signDelegation(body2, kpBogus.privateKey);

    const result = await verifyDelegationChain([delegation1, delegation2]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Chain break at 1");
    expect(result.error).toContain("public_key");
  });

  it("tampered delegation fails signature check", async () => {
    const kpAlice = await generateKeypair();
    const kpService = await generateKeypair();

    const delegation = await makeDelegation(
      kpAlice, kpService, "mote-alice", "mote-web-search",
    );

    const tampered: DelegationToken = { ...delegation, scope: "TAMPERED_SCOPE" };

    const result = await verifyDelegationChain([tampered]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Delegation 0");
    expect(result.error).toContain("invalid signature");
  });

  it("verifyDelegation standalone works", async () => {
    const kpAlice = await generateKeypair();
    const kpService = await generateKeypair();

    const delegation = await makeDelegation(
      kpAlice, kpService, "mote-alice", "mote-web-search",
    );

    expect(await verifyDelegation(delegation)).toBe(true);

    const tampered: DelegationToken = { ...delegation, delegate_id: "mote-imposter" };
    expect(await verifyDelegation(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: delegation chain with receipt sequence (realistic scenario)
// ---------------------------------------------------------------------------

describe("end-to-end: delegation chain with receipt sequence", () => {
  it("Alice delegates to web-search, which executes and returns a signed receipt", async () => {
    const kpAlice = await generateKeypair();
    const kpWebSearch = await generateKeypair();

    const delegation = await signDelegation(
      {
        delegator_id: "mote-alice",
        delegator_public_key: toBase64Url(kpAlice.publicKey),
        delegate_id: "mote-web-search",
        delegate_public_key: toBase64Url(kpWebSearch.publicKey),
        scope: "web_search",
        issued_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      },
      kpAlice.privateKey,
    );

    const delegationResult = await verifyDelegationChain([delegation]);
    expect(delegationResult.valid).toBe(true);

    const promptHash = await hash(new TextEncoder().encode("search for motebit"));
    const resultText = JSON.stringify({ results: [{ title: "Motebit", url: "https://motebit.com" }] });
    const resultHash = await hash(new TextEncoder().encode(resultText));

    const receipt = await signExecutionReceipt(
      {
        task_id: "task-ws-001",
        motebit_id: "mote-web-search",
        device_id: "device-ws-001",
        submitted_at: 1700000000000,
        completed_at: 1700000005000,
        status: "completed",
        result: resultText,
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: promptHash,
        result_hash: resultHash,
      },
      kpWebSearch.privateKey,
    );

    const receiptResult = await verifyReceiptSequence([
      { receipt, signer_public_key: kpWebSearch.publicKey },
    ]);
    expect(receiptResult.valid).toBe(true);

    expect(toBase64Url(kpWebSearch.publicKey)).toBe(delegation.delegate_public_key);
  });

  it("three-hop delegation with receipt sequence: Alice -> B -> C", async () => {
    const kpAlice = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const d1 = await signDelegation(
      {
        delegator_id: "mote-alice",
        delegator_public_key: toBase64Url(kpAlice.publicKey),
        delegate_id: "mote-service-b",
        delegate_public_key: toBase64Url(kpB.publicKey),
        scope: "research",
        issued_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      },
      kpAlice.privateKey,
    );
    const d2 = await signDelegation(
      {
        delegator_id: "mote-service-b",
        delegator_public_key: toBase64Url(kpB.publicKey),
        delegate_id: "mote-service-c",
        delegate_public_key: toBase64Url(kpC.publicKey),
        scope: "read_url",
        issued_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      },
      kpB.privateKey,
    );

    const delegResult = await verifyDelegationChain([d1, d2]);
    expect(delegResult.valid).toBe(true);

    const receiptB = await signExecutionReceipt(
      makeReceipt({
        task_id: "task-b-001",
        motebit_id: "mote-service-b",
        submitted_at: 1700000000000,
        completed_at: 1700000010000,
        result: "Delegated read to C",
        tools_used: ["motebit_task"],
      }),
      kpB.privateKey,
    );
    const receiptC = await signExecutionReceipt(
      makeReceipt({
        task_id: "task-c-001",
        motebit_id: "mote-service-c",
        submitted_at: 1700000010000,
        completed_at: 1700000020000,
        result: "Page content fetched",
        tools_used: ["read_url"],
      }),
      kpC.privateKey,
    );

    const receiptResult = await verifyReceiptSequence([
      { receipt: receiptB, signer_public_key: kpB.publicKey },
      { receipt: receiptC, signer_public_key: kpC.publicKey },
    ]);
    expect(receiptResult.valid).toBe(true);

    expect(toBase64Url(kpB.publicKey)).toBe(d1.delegate_public_key);
    expect(toBase64Url(kpC.publicKey)).toBe(d2.delegate_public_key);
  });
});
