/**
 * @vitest-environment jsdom
 *
 * Forgetting a memory on desktop renders the deletion certificate the
 * runtime actually returns — the SIGNED `mutable_pruning` certificate from
 * `@motebit/protocol` (privacy-layer `deleteMemory` → `signCertAsSubject`).
 * The panel used to cast it to the retired unsigned shape and read
 * `cert.tombstone_hash.slice(...)`, a field the signed certificate does not
 * have — a TypeError after every delete, so the "Deleted" notice never
 * rendered and the list never refreshed.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- the test mints a real signed certificate
import { generateKeypair, signCertAsSubject } from "@motebit/crypto";
import type { DeletionCertificate, NodeId } from "@motebit/protocol";
import type { DesktopContext } from "../types";

function mountMemoryDom(): void {
  document.body.innerHTML = `
    <div id="memory-panel"></div>
    <div id="memory-backdrop"></div>
    <div id="memory-list"></div>
    <span id="memory-count"></span>
    <input id="memory-search" />
    <div id="memory-graph-wrap"><canvas id="memory-graph-canvas"></canvas>
      <div id="memory-graph-tooltip"></div></div>
    <button id="mem-view-list"></button>
    <button id="mem-view-graph"></button>
    <button id="mem-view-deletions"></button>
    <button id="mem-view-consolidations"></button>
    <button id="memory-btn"></button>
    <button id="memory-close-btn"></button>
  `;
}

let memory: typeof import("../ui/memory");

beforeAll(async () => {
  mountMemoryDom();
  memory = await import("../ui/memory");
}, 60_000);

async function signedCert(): Promise<Extract<DeletionCertificate, { kind: "mutable_pruning" }>> {
  const kp = await generateKeypair();
  return signCertAsSubject(
    {
      kind: "mutable_pruning",
      target_id: "node-1" as NodeId,
      sensitivity: "none",
      reason: "user_request",
      deleted_at: 1_700_000_000_000,
    },
    "motebit-test",
    kp.privateKey,
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("desktop memory panel — delete renders the signed certificate", () => {
  it("shows the Deleted notice keyed to the certificate's signature", async () => {
    const cert = await signedCert();
    const errors: unknown[] = [];
    const onRejection = (e: unknown): void => {
      errors.push(e);
    };
    process.on("unhandledRejection", onRejection);

    const app = {
      listMemories: vi.fn(async () => [
        {
          node_id: "node-1",
          content: "likes tea",
          confidence: 0.9,
          sensitivity: "none",
          embedding: [],
          created_at: 1,
          last_accessed: 1,
          half_life: 7 * 86_400_000,
          tombstoned: false,
          pinned: false,
        },
      ]),
      deleteMemory: vi.fn(async () => cert),
      pinMemory: vi.fn(async () => undefined),
      getDecayedConfidence: vi.fn(() => 0.9),
      listMemoryEdges: vi.fn(async () => []),
    };
    const api = memory.initMemory({ app } as unknown as DesktopContext);
    api.open();
    await flush();

    const item = document.querySelector<HTMLElement>('.mem-item[data-node-id="node-1"]');
    expect(item).not.toBeNull();
    const del = item!.querySelector<HTMLButtonElement>(".mem-delete-btn")!;
    del.click(); // enter confirm
    del.click(); // confirm → deleteMemory
    await flush();
    process.off("unhandledRejection", onRejection);

    expect(app.deleteMemory).toHaveBeenCalledWith("node-1");
    expect(errors).toEqual([]);
    const notice = item!.querySelector(".mem-cert-notice");
    expect(notice?.textContent).toContain("Deleted");
    const hash = item!.querySelector<HTMLElement>(".mem-cert-hash")!;
    const sig = cert.subject_signature!.signature;
    expect(hash.title).toBe(sig);
    expect(hash.textContent).toBe(`cert: ${sig.slice(0, 12)}...`);
  });
});
