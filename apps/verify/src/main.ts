/**
 * receipt verifier — main entry. DOM wiring only: read the pasted receipt,
 * verify it offline via @motebit/state-export-client, render the honest result.
 * No network, no login, no relay contact — the verification runs in this tab.
 */

import { verifyReceiptDocument } from "@motebit/state-export-client";
import { renderResult } from "./render.js";

const input = document.getElementById("receipt-input") as HTMLTextAreaElement;
const verifyBtn = document.getElementById("verify-btn") as HTMLButtonElement;
const resultContainer = document.getElementById("result-container")!;

async function run(): Promise<void> {
  const text = input.value.trim();
  if (text.length === 0) return;
  verifyBtn.disabled = true;
  try {
    const view = await verifyReceiptDocument(text);
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
