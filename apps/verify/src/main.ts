/**
 * receipt verifier — main entry. DOM wiring only: read the pasted receipt, verify
 * it via @motebit/state-export-client, render the graded verdict into the result
 * pane. Verifies live (debounced) as you type — jwt.io-style — plus the button and
 * ⌘/Ctrl+Enter.
 *
 * The integrity check runs entirely in this tab. When the receipt names a producer,
 * the binding is upgraded toward pinned/anchored/sovereign by fetching the relay's
 * identity material (default https://relay.motebit.com, VITE_RELAY_URL) and the
 * key's on-chain revocation status — fail-closed: any relay failure keeps the
 * offline integrity-only result.
 */

import { verifyReceiptDocument } from "@motebit/state-export-client";
import { renderResult } from "./render.js";
import { resolveReceiptBinding } from "./relay-binding.js";

const input = document.getElementById("receipt-input") as HTMLTextAreaElement;
const verifyBtn = document.getElementById("verify-btn") as HTMLButtonElement;
const resultContainer = document.getElementById("result-container")!;
// The initial child is the "what gets verified" empty state — re-shown when cleared.
const emptyState = resultContainer.firstElementChild;

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "https://relay.motebit.com";
const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC_URL;

async function run(): Promise<void> {
  const text = input.value.trim();
  if (text.length === 0) {
    if (emptyState) resultContainer.replaceChildren(emptyState);
    return;
  }
  verifyBtn.disabled = true;
  try {
    let view = await verifyReceiptDocument(text);
    // Upgrade past integrity-only when the receipt names a producer. Fail-closed:
    // resolveReceiptBinding returns null on any relay failure.
    if (view.integrity && view.motebitId) {
      const resolved = await resolveReceiptBinding({
        relayBase: RELAY_URL,
        motebitId: view.motebitId,
        ...(SOLANA_RPC ? { solanaRpc: SOLANA_RPC } : {}),
      });
      if (resolved) {
        view = await verifyReceiptDocument(text, {
          identity: resolved.identity,
          ...(resolved.anchor ? { anchor: resolved.anchor } : {}),
          revocation: {
            relayAnchorAddress: resolved.relayAnchorAddress,
            lookup: SOLANA_RPC ? { rpcUrl: SOLANA_RPC } : {},
          },
        });
      }
    }
    resultContainer.replaceChildren(renderResult(view));
  } finally {
    verifyBtn.disabled = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
input.addEventListener("input", () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void run(), 400);
});
verifyBtn.addEventListener("click", () => void run());
input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
});
