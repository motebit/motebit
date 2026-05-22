/**
 * receipt verifier — main entry. DOM wiring only: read the pasted receipt,
 * verify it via @motebit/state-export-client, render the honest result.
 *
 * The integrity check runs entirely in this tab (no network). A verified receipt
 * is then upgraded toward pinned/anchored by fetching the producing motebit's
 * identity material from the relay (default `https://relay.motebit.com`,
 * overridable via VITE_RELAY_URL) — fail-closed: any relay failure keeps the
 * offline integrity-only result.
 */

import { verifyReceiptDocument } from "@motebit/state-export-client";
import { renderResult } from "./render.js";
import { resolveReceiptBinding } from "./relay-binding.js";

const input = document.getElementById("receipt-input") as HTMLTextAreaElement;
const verifyBtn = document.getElementById("verify-btn") as HTMLButtonElement;
const resultContainer = document.getElementById("result-container")!;

// Same canonical var + default as apps/web (storage.ts) — the sync/identity relay.
const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "https://relay.motebit.com";
const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC_URL;

async function run(): Promise<void> {
  const text = input.value.trim();
  if (text.length === 0) return;
  verifyBtn.disabled = true;
  try {
    let view = await verifyReceiptDocument(text);
    // Upgrade past integrity-only when the receipt names a producer. Fail-closed:
    // resolveReceiptBinding returns null on any relay failure, so an unreachable
    // relay never blocks the offline integrity check.
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
        });
      }
    }
    resultContainer.replaceChildren(renderResult(view));
  } finally {
    verifyBtn.disabled = false;
  }
}

verifyBtn.addEventListener("click", () => void run());
// Cmd/Ctrl+Enter from the textarea verifies, matching a code-editor reflex.
input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
});
