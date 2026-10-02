/**
 * receipt.computer — main entry. DOM wiring only: the JSON pane, the Verify /
 * Mint tabs, the sample + Tamper + Reset controls, the shareable `#r=` link, and
 * handing each receipt to @motebit/state-export-client for verification. The
 * page is never empty: with no `#r=` fragment it loads the committed sample.
 *
 * The integrity check runs entirely in this tab. For a pasted or linked receipt
 * that names a producer, the binding is upgraded toward pinned/anchored by
 * fetching the relay's identity material (default https://relay.motebit.com,
 * VITE_RELAY_URL) and the key's on-chain revocation status — fail-closed: any
 * relay failure keeps the offline result, and the ladder says so. The sample and
 * minted receipts are demo keys no relay knows, so they stay offline.
 */

import {
  verifyReceiptDocument,
  type ReceiptDocumentVerification,
} from "@motebit/state-export-client";
import { renderResult } from "./render.js";
import { resolveReceiptBinding } from "./relay-binding.js";
import type { RelayContext } from "./ladder.js";
import { SAMPLE_JSON, tamperResult } from "./sample.js";
import { decodeFragment, encodeFragment, MAX_FRAGMENT_CHARS } from "./fragment.js";
import { highlightJson } from "./highlight.js";
import { mintDemoReceipt } from "./mint.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = $<HTMLTextAreaElement>("receipt-input");
const paint = $<HTMLPreElement>("receipt-paint");
const verifyBtn = $<HTMLButtonElement>("verify-btn");
const tamperBtn = $<HTMLButtonElement>("tamper-btn");
const resetBtn = $<HTMLButtonElement>("reset-btn");
const linkBtn = $<HTMLButtonElement>("link-btn");
const sourceLabel = $("source-label");
const statusLine = $("status");
const resultContainer = $("result-container");
const emptyState = resultContainer.firstElementChild;

const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "https://relay.motebit.com";
const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC_URL;

type Source = "sample" | "tampered-sample" | "minted" | "link" | "pasted";
const SOURCE_TEXT: Record<Source, string> = {
  sample: "sample — signed by a demo key",
  "tampered-sample": "sample, tampered — one byte of result flipped",
  minted: "minted here — demo key, generated in your browser, never sent anywhere",
  link: "from a shared link — read from the URL fragment, never sent to a server",
  pasted: "your receipt",
};
let source: Source = "sample";

function setSource(s: Source): void {
  source = s;
  sourceLabel.textContent = SOURCE_TEXT[s];
}

function say(msg: string): void {
  statusLine.textContent = msg;
}

// ── JSON pane: colored layer under the transparent textarea ──
function repaint(): void {
  const frag = document.createDocumentFragment();
  for (const seg of highlightJson(input.value)) {
    const span = document.createElement("span");
    span.className = `role-${seg.role}`;
    span.textContent = seg.text;
    frag.append(span);
  }
  // A trailing newline keeps the last (empty) line's height in step with the textarea.
  frag.append("\n");
  paint.replaceChildren(frag);
  paint.scrollTop = input.scrollTop;
}

function setText(text: string, s: Source): void {
  input.value = text;
  setSource(s);
  repaint();
}

function offline(reason: string): RelayContext {
  return { kind: "offline", reason };
}

// ── Verify ──
let runSeq = 0;
async function run(): Promise<void> {
  const text = input.value.trim();
  const seq = ++runSeq;
  if (text.length === 0) {
    if (emptyState) resultContainer.replaceChildren(emptyState);
    return;
  }
  verifyBtn.disabled = true;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    let view: ReceiptDocumentVerification = await verifyReceiptDocument(text);
    let ctx: RelayContext;
    if (source === "sample" || source === "tampered-sample") {
      ctx = offline("offline — the sample is verified in this tab, with no relay context");
    } else if (source === "minted") {
      ctx = offline("offline — the demo key was never registered with a relay");
    } else if (!view.integrity) {
      ctx = offline("integrity failed");
    } else if (!view.motebitId) {
      ctx = offline("offline — the receipt names no motebit_id");
    } else {
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
        ctx = { kind: "resolved" };
      } else {
        ctx = {
          kind: "unavailable",
          reason: "the relay was unreachable or has no identity record for this motebit",
        };
      }
    }
    if (seq !== runSeq) return; // a newer edit superseded this run
    resultContainer.replaceChildren(renderResult(view, { receipt: parsed, ctx }));
  } finally {
    if (seq === runSeq) verifyBtn.disabled = false;
  }
}

// ── Editing ──
let debounce: ReturnType<typeof setTimeout> | undefined;
input.addEventListener("input", () => {
  repaint();
  setSource(input.value === SAMPLE_JSON ? "sample" : "pasted");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  say("");
  if (debounce !== undefined) clearTimeout(debounce);
  debounce = setTimeout(() => void run(), 400);
});
input.addEventListener("scroll", () => {
  paint.scrollTop = input.scrollTop;
});
input.addEventListener("paste", () => {
  // Pretty-print once the pasted text lands, if the whole pane is JSON.
  setTimeout(() => {
    try {
      const pretty = JSON.stringify(JSON.parse(input.value), null, 2);
      if (pretty !== input.value) {
        input.value = pretty;
        repaint();
      }
    } catch {
      /* not (yet) JSON — leave it as typed */
    }
  }, 0);
});
verifyBtn.addEventListener("click", () => void run());
input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
});

// ── Sample controls ──
tamperBtn.addEventListener("click", () => {
  const t = tamperResult(input.value);
  if (t === null) {
    say("Nothing to tamper with — the receipt has no text result.");
    return;
  }
  setText(t, source === "sample" || source === "tampered-sample" ? "tampered-sample" : "pasted");
  say("");
  void run();
});
resetBtn.addEventListener("click", () => {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  setText(SAMPLE_JSON, "sample");
  say("");
  void run();
});

// ── Shareable link ──
linkBtn.addEventListener("click", () => {
  const enc = encodeFragment(input.value);
  if (!enc.ok) {
    say(
      enc.reason === "too_large"
        ? `Too large for a link — ${Math.ceil(Number(enc.size) / 1000)} KB encoded, the limit is ${MAX_FRAGMENT_CHARS / 1000} KB. Share the JSON instead.`
        : "Only valid JSON can be linked.",
    );
    return;
  }
  history.replaceState(null, "", enc.hash);
  const url = location.href;
  navigator.clipboard.writeText(url).then(
    () => say("Link copied. The receipt travels in the fragment, never to a server."),
    () => say("Copy failed — the link is in the address bar."),
  );
});

function loadFromLocation(): void {
  const frag = decodeFragment(location.hash);
  if (frag === null) {
    setText(SAMPLE_JSON, "sample");
  } else if (frag.ok) {
    setText(frag.json, "link");
  } else {
    setText(SAMPLE_JSON, "sample");
    say(
      frag.reason === "too_large"
        ? "The link's receipt is over the size limit — showing the sample instead."
        : "The link's receipt could not be read — showing the sample instead.",
    );
  }
  void run();
}
window.addEventListener("hashchange", loadFromLocation);

// ── Tabs ──
const tabs = [$<HTMLButtonElement>("tab-verify"), $<HTMLButtonElement>("tab-mint")];
function selectTab(i: number, focus = false): void {
  tabs.forEach((t, j) => {
    const on = i === j;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")!).hidden = !on;
  });
  if (focus) tabs[i]!.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(i));
  t.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      selectTab((i + 1) % tabs.length, true);
    }
  });
});

// ── Mint (throwaway key: lives only inside mintDemoReceipt's call) ──
const mintForm = $<HTMLFormElement>("mint-form");
const mintBtn = $<HTMLButtonElement>("mint-btn");
mintForm.addEventListener("submit", (e) => {
  e.preventDefault();
  mintBtn.disabled = true;
  const prompt = $<HTMLInputElement>("mint-prompt").value;
  const result = $<HTMLTextAreaElement>("mint-result").value;
  mintDemoReceipt({ prompt, result })
    .then((json) => {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      setText(json, "minted");
      say("");
      selectTab(0);
      void run();
    })
    .catch((err: unknown) =>
      say(`Signing failed: ${err instanceof Error ? err.message : String(err)}`),
    )
    .finally(() => {
      mintBtn.disabled = false;
    });
});

loadFromLocation();
