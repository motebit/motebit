import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signExecutionReceipt,
  verifyExecutionReceipt,
  verifyReceiptSequence,
  signDelegation,
  verifyDelegation,
  verifyDelegationChain,
  signCollaborativeReceipt,
  verifyCollaborativeReceipt,
  parseScopeSet,
  isScopeNarrowed,
  toBase64Url,
  hash,
  type SignableReceipt,
  type DelegationToken,
  type ReceiptChainEntry,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceipt(
  overrides: Partial<Omit<SignableReceipt, "signature" | "suite">> = {},
): Omit<SignableReceipt, "signature" | "suite"> {
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

    const chain: ReceiptChainEntry[] = [{ receipt: signed, signer_public_key: kp.publicKey }];
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

    const signed = await signExecutionReceipt(makeReceipt({ task_id: "x" }), kpReal.privateKey);

    const chain: ReceiptChainEntry[] = [{ receipt: signed, signer_public_key: kpWrong.publicKey }];

    const result = await verifyReceiptSequence(chain);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Receipt 0");
    expect(result.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyDelegation — error paths
// ---------------------------------------------------------------------------

describe("verifyDelegation error paths", () => {
  it("returns false when signature is not valid base64url", async () => {
    const kp = await generateKeypair();
    const delegation: DelegationToken = {
      delegator_id: "mote-alice",
      delegator_public_key: toBase64Url(kp.publicKey),
      delegate_id: "mote-bob",
      delegate_public_key: toBase64Url(kp.publicKey),
      scope: "web_search",
      issued_at: Date.now(),
      expires_at: Date.now() + 3600_000,
      signature: "!!!not-valid-base64!!!",
    };
    const result = await verifyDelegation(delegation);
    expect(result).toBe(false);
  });

  it("returns false when delegator_public_key is not valid base64url", async () => {
    const kp = await generateKeypair();
    const delegation: DelegationToken = {
      delegator_id: "mote-alice",
      delegator_public_key: "!!!bad-key!!!",
      delegate_id: "mote-bob",
      delegate_public_key: toBase64Url(kp.publicKey),
      scope: "web_search",
      issued_at: Date.now(),
      expires_at: Date.now() + 3600_000,
      signature: toBase64Url(new Uint8Array(64)),
    };
    const result = await verifyDelegation(delegation);
    expect(result).toBe(false);
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

    const delegation = await makeDelegation(kpAlice, kpService, "mote-alice", "mote-web-search");

    const result = await verifyDelegationChain([delegation]);
    expect(result.valid).toBe(true);
  });

  it("multi-hop delegation chain verifies (Alice -> B -> C)", async () => {
    const kpAlice = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const delegation1 = await makeDelegation(
      kpAlice,
      kpB,
      "mote-alice",
      "mote-service-b",
      "web_search,read_url",
    );
    const delegation2 = await makeDelegation(
      kpB,
      kpC,
      "mote-service-b",
      "mote-service-c",
      "read_url",
    );

    const result = await verifyDelegationChain([delegation1, delegation2]);
    expect(result.valid).toBe(true);
  });

  it("broken chain fails — delegate_id mismatch", async () => {
    const kpAlice = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const delegation1 = await makeDelegation(kpAlice, kpB, "mote-alice", "mote-service-b");
    const delegation2 = await makeDelegation(kpB, kpC, "mote-service-WRONG", "mote-service-c");

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

    const delegation1 = await makeDelegation(kpAlice, kpB, "mote-alice", "mote-service-b");
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

    const delegation = await makeDelegation(kpAlice, kpService, "mote-alice", "mote-web-search");

    const tampered: DelegationToken = { ...delegation, scope: "TAMPERED_SCOPE" };

    const result = await verifyDelegationChain([tampered]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Delegation 0");
    expect(result.error).toContain("invalid signature");
  });

  it("verifyDelegation standalone works", async () => {
    const kpAlice = await generateKeypair();
    const kpService = await generateKeypair();

    const delegation = await makeDelegation(kpAlice, kpService, "mote-alice", "mote-web-search");

    expect(await verifyDelegation(delegation)).toBe(true);

    const tampered: DelegationToken = { ...delegation, delegate_id: "mote-imposter" };
    expect(await verifyDelegation(tampered)).toBe(false);
  });

  it("verifyDelegation rejects expired tokens by default", async () => {
    const kpAlice = await generateKeypair();
    const kpService = await generateKeypair();

    const expired: DelegationToken = await signDelegation(
      {
        delegator_id: "mote-alice",
        delegator_public_key: toBase64Url(kpAlice.publicKey),
        delegate_id: "mote-web-search",
        delegate_public_key: toBase64Url(kpService.publicKey),
        scope: "web_search",
        issued_at: Date.now() - 7200_000,
        expires_at: Date.now() - 3600_000, // expired 1 hour ago
      },
      kpAlice.privateKey,
    );

    // Default: checkExpiry=true — reject expired
    expect(await verifyDelegation(expired)).toBe(false);

    // Explicit checkExpiry=false — accept for historical verification
    expect(await verifyDelegation(expired, { checkExpiry: false })).toBe(true);
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
    const resultText = JSON.stringify({
      results: [{ title: "Motebit", url: "https://motebit.com" }],
    });
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
        scope: "research,read_url",
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

// ---------------------------------------------------------------------------
// signCollaborativeReceipt / verifyCollaborativeReceipt
// ---------------------------------------------------------------------------

describe("signCollaborativeReceipt / verifyCollaborativeReceipt", () => {
  it("round-trip: sign then verify", async () => {
    const initiatorKp = await generateKeypair();
    const participantKp = await generateKeypair();

    // Create a participant receipt
    const participantReceipt = await signExecutionReceipt(
      {
        task_id: "task-1",
        motebit_id: "participant-1",
        device_id: "dev-1",
        submitted_at: 1000,
        completed_at: 2000,
        status: "completed",
        result: "done",
        tools_used: ["tool_a"],
        memories_formed: 1,
        prompt_hash: "abc",
        result_hash: "def",
      },
      participantKp.privateKey,
    );

    const collaborative = await signCollaborativeReceipt(
      {
        proposal_id: "prop-1",
        plan_id: "plan-1",
        participant_receipts: [participantReceipt],
      },
      initiatorKp.privateKey,
    );

    expect(collaborative.content_hash).toBeTruthy();
    expect(collaborative.initiator_signature).toBeTruthy();

    const result = await verifyCollaborativeReceipt(collaborative, initiatorKp.publicKey);
    expect(result.valid).toBe(true);
  });

  it("detects tampered content hash", async () => {
    const kp = await generateKeypair();

    const collaborative = await signCollaborativeReceipt(
      {
        proposal_id: "prop-2",
        plan_id: "plan-2",
        participant_receipts: [],
      },
      kp.privateKey,
    );

    const tampered = { ...collaborative, content_hash: "tampered" };
    const result = await verifyCollaborativeReceipt(tampered, kp.publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Content hash mismatch");
  });

  it("detects invalid initiator signature", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();

    const collaborative = await signCollaborativeReceipt(
      {
        proposal_id: "prop-3",
        plan_id: "plan-3",
        participant_receipts: [],
      },
      kp1.privateKey,
    );

    // Verify with wrong key
    const result = await verifyCollaborativeReceipt(collaborative, kp2.publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Initiator signature invalid");
  });

  it("verifies participant receipts when keys provided", async () => {
    const initiatorKp = await generateKeypair();
    const participantKp = await generateKeypair();
    const wrongKp = await generateKeypair();

    const participantReceipt = await signExecutionReceipt(
      {
        task_id: "task-2",
        motebit_id: "participant-2",
        device_id: "dev-2",
        submitted_at: 1000,
        completed_at: 2000,
        status: "completed",
        result: "done",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "aaa",
        result_hash: "bbb",
      },
      participantKp.privateKey,
    );

    const collaborative = await signCollaborativeReceipt(
      {
        proposal_id: "prop-4",
        plan_id: "plan-4",
        participant_receipts: [participantReceipt],
      },
      initiatorKp.privateKey,
    );

    // Verify with correct participant key
    const knownKeys = new Map<string, Uint8Array>();
    knownKeys.set("participant-2", participantKp.publicKey);

    const result1 = await verifyCollaborativeReceipt(
      collaborative,
      initiatorKp.publicKey,
      knownKeys,
    );
    expect(result1.valid).toBe(true);

    // Verify with wrong participant key
    const wrongKeys = new Map<string, Uint8Array>();
    wrongKeys.set("participant-2", wrongKp.publicKey);

    const result2 = await verifyCollaborativeReceipt(
      collaborative,
      initiatorKp.publicKey,
      wrongKeys,
    );
    expect(result2.valid).toBe(false);
    expect(result2.error).toContain("signature invalid");
  });

  it("rejects when participant motebit_id is not in knownKeys", async () => {
    const initiatorKp = await generateKeypair();
    const participantKp = await generateKeypair();

    const participantReceipt = await signExecutionReceipt(
      makeReceipt({ motebit_id: "participant-unknown" }),
      participantKp.privateKey,
    );

    const collaborative = await signCollaborativeReceipt(
      {
        proposal_id: "prop-5",
        plan_id: "plan-5",
        participant_receipts: [participantReceipt],
      },
      initiatorKp.privateKey,
    );

    // knownKeys has a different motebit_id — "participant-unknown" is missing
    const knownKeys = new Map<string, Uint8Array>();
    knownKeys.set("some-other-agent", participantKp.publicKey);

    const result = await verifyCollaborativeReceipt(
      collaborative,
      initiatorKp.publicKey,
      knownKeys,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown participant key");
  });

  it("rejects when initiator_signature is not valid base64url", async () => {
    const initiatorKp = await generateKeypair();
    const participantKp = await generateKeypair();

    const participantReceipt = await signExecutionReceipt(
      makeReceipt({ motebit_id: "participant-6" }),
      participantKp.privateKey,
    );

    const collaborative = await signCollaborativeReceipt(
      {
        proposal_id: "prop-6",
        plan_id: "plan-6",
        participant_receipts: [participantReceipt],
      },
      initiatorKp.privateKey,
    );

    // Corrupt the initiator_signature to trigger decode failure
    collaborative.initiator_signature = "!!!not-valid-base64!!!";

    const result = await verifyCollaborativeReceipt(collaborative, initiatorKp.publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("decode failed");
  });
});

// ---------------------------------------------------------------------------
// parseScopeSet
// ---------------------------------------------------------------------------

describe("parseScopeSet", () => {
  it("parses comma-separated capabilities", () => {
    const result = parseScopeSet("web_search,read_url");
    expect(result).toEqual(new Set(["web_search", "read_url"]));
  });

  it("handles wildcard", () => {
    const result = parseScopeSet("*");
    expect(result).toEqual(new Set(["*"]));
  });

  it("trims whitespace", () => {
    const result = parseScopeSet(" web_search , read_url ");
    expect(result).toEqual(new Set(["web_search", "read_url"]));
  });

  it("handles single capability", () => {
    const result = parseScopeSet("web_search");
    expect(result).toEqual(new Set(["web_search"]));
  });

  it("filters out empty strings from trailing commas", () => {
    const result = parseScopeSet("web_search,,read_url,");
    expect(result).toEqual(new Set(["web_search", "read_url"]));
  });

  it("handles empty string", () => {
    const result = parseScopeSet("");
    expect(result).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// isScopeNarrowed
// ---------------------------------------------------------------------------

describe("isScopeNarrowed", () => {
  it("wildcard parent allows any child", () => {
    expect(isScopeNarrowed("*", "web_search")).toBe(true);
    expect(isScopeNarrowed("*", "web_search,read_url")).toBe(true);
    expect(isScopeNarrowed("*", "*")).toBe(true);
  });

  it("child wildcard requires parent wildcard", () => {
    expect(isScopeNarrowed("web_search,read_url", "*")).toBe(false);
    expect(isScopeNarrowed("web_search", "*")).toBe(false);
  });

  it("proper subset is valid", () => {
    expect(isScopeNarrowed("web_search,read_url,summarize", "web_search,read_url")).toBe(true);
    expect(isScopeNarrowed("web_search,read_url", "web_search")).toBe(true);
  });

  it("equal sets are valid", () => {
    expect(isScopeNarrowed("web_search,read_url", "web_search,read_url")).toBe(true);
    expect(isScopeNarrowed("web_search", "web_search")).toBe(true);
  });

  it("superset child is invalid (scope widening)", () => {
    expect(isScopeNarrowed("web_search", "web_search,read_url")).toBe(false);
  });

  it("disjoint child is invalid", () => {
    expect(isScopeNarrowed("web_search", "read_url")).toBe(false);
  });

  it("partially overlapping child is invalid if not subset", () => {
    expect(isScopeNarrowed("web_search,read_url", "web_search,execute_code")).toBe(false);
  });

  it("empty child is always valid (no capabilities requested)", () => {
    expect(isScopeNarrowed("web_search", "")).toBe(true);
    expect(isScopeNarrowed("*", "")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyDelegationChain — scope narrowing enforcement
// ---------------------------------------------------------------------------

describe("verifyDelegationChain — scope narrowing", () => {
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

  it("valid narrowing: parent=web_search,read_url child=web_search", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "web_search,read_url");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "web_search");

    const result = await verifyDelegationChain([d1, d2]);
    expect(result.valid).toBe(true);
  });

  it("valid narrowing: parent=* child=web_search", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "*");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "web_search");

    const result = await verifyDelegationChain([d1, d2]);
    expect(result.valid).toBe(true);
  });

  it("invalid widening: parent=web_search child=web_search,read_url", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "web_search");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "web_search,read_url");

    const result = await verifyDelegationChain([d1, d2]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("widens scope");
  });

  it("invalid widening: parent=web_search child=*", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "web_search");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "*");

    const result = await verifyDelegationChain([d1, d2]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("widens scope");
  });

  it("three-hop narrowing: * -> web_search,read_url -> read_url", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const kpD = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "*");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "web_search,read_url");
    const d3 = await makeDelegation(kpC, kpD, "c", "d", "read_url");

    const result = await verifyDelegationChain([d1, d2, d3]);
    expect(result.valid).toBe(true);
  });

  it("three-hop with widening at hop 3 fails", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();
    const kpD = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "*");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "read_url");
    const d3 = await makeDelegation(kpC, kpD, "c", "d", "read_url,web_search");

    const result = await verifyDelegationChain([d1, d2, d3]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Delegation 2");
    expect(result.error).toContain("widens scope");
  });

  it("equal scope at each hop is valid", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const kpC = await generateKeypair();

    const d1 = await makeDelegation(kpA, kpB, "a", "b", "web_search");
    const d2 = await makeDelegation(kpB, kpC, "b", "c", "web_search");

    const result = await verifyDelegationChain([d1, d2]);
    expect(result.valid).toBe(true);
  });
});
