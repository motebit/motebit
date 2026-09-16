/**
 * `RelayClient.sendAgentCommand` — the first production minter of an
 * `agent-command/{motebit_id}` envelope.
 *
 * The verification stack has shipped fail-closed on every surface since
 * the unification arc with nothing signing for it. The test that matters
 * is therefore the round trip: what this mints must be what
 * `verifyAgentCommandEnvelope` accepts, and must be rejected the moment
 * anything about the command changes.
 */
import { describe, it, expect, vi } from "vitest";
import { RelayClient, RelayClientError } from "../index.js";
import { generateKeypair, verifyAgentCommandEnvelope } from "@motebit/crypto";

const MOTEBIT_ID = "mote-remote-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sendAgentCommand", () => {
  it("mints an envelope the runtime's own verifier accepts", async () => {
    const kp = await generateKeypair();
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return jsonResponse({ summary: "Stopped all unattended execution." });
    }) as unknown as typeof fetch;

    const client = new RelayClient({ baseUrl: "https://relay.example", fetchImpl });
    const result = await client.sendAgentCommand({
      motebitId: MOTEBIT_ID,
      command: "halt",
      args: "going out",
      identityPrivateKey: kp.privateKey,
    });

    expect(result.summary).toBe("Stopped all unattended execution.");
    expect(sent?.command).toBe("halt");
    expect(sent?.args).toBe("going out");

    const verdict = await verifyAgentCommandEnvelope({
      envelope: sent?.envelope,
      command: "halt",
      args: "going out",
      motebitId: MOTEBIT_ID,
      identityPublicKey: kp.publicKey,
    });
    expect(verdict.ok).toBe(true);
  });

  it("the envelope is bound to the exact command and args — a swap is refused", async () => {
    const kp = await generateKeypair();
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return jsonResponse({ summary: "ok" });
    }) as unknown as typeof fetch;
    const client = new RelayClient({ baseUrl: "https://relay.example", fetchImpl });
    await client.sendAgentCommand({
      motebitId: MOTEBIT_ID,
      command: "halt",
      identityPrivateKey: kp.privateKey,
    });

    // Same envelope, different verb: a relay that swapped `halt` for
    // `resume` in transit would be caught here.
    const swapped = await verifyAgentCommandEnvelope({
      envelope: sent?.envelope,
      command: "resume",
      motebitId: MOTEBIT_ID,
      identityPublicKey: kp.publicKey,
    });
    expect(swapped.ok).toBe(false);

    // …and a different signer is not this motebit.
    const other = await generateKeypair();
    const foreign = await verifyAgentCommandEnvelope({
      envelope: sent?.envelope,
      command: "halt",
      motebitId: MOTEBIT_ID,
      identityPublicKey: other.publicKey,
    });
    expect(foreign.ok).toBe(false);
  });

  it("a runtime that is not connected surfaces as an http error, never as a result", async () => {
    const kp = await generateKeypair();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "Agent not connected" }, 503),
    ) as unknown as typeof fetch;
    const client = new RelayClient({ baseUrl: "https://relay.example", fetchImpl });
    await expect(
      client.sendAgentCommand({
        motebitId: MOTEBIT_ID,
        command: "halt",
        identityPrivateKey: kp.privateKey,
      }),
    ).rejects.toMatchObject({ kind: "http", status: 503 });
  });

  it("a response without a summary is a parse failure, not a silent success", async () => {
    const kp = await generateKeypair();
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    const client = new RelayClient({ baseUrl: "https://relay.example", fetchImpl });
    await expect(
      client.sendAgentCommand({
        motebitId: MOTEBIT_ID,
        command: "halt-status",
        identityPrivateKey: kp.privateKey,
      }),
    ).rejects.toBeInstanceOf(RelayClientError);
  });
});
