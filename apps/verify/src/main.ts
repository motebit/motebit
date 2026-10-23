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
 *
 * What is SHOWN is the display verdict (`assess.ts`), never the raw view: the
 * identity binding comes from the page's own check of the relay-served chain
 * (`served-chain.ts`, no file-named guardian honoured, canonical ids only) —
 * PINNED when it binds the key at the receipt's CLAIMED time (completed_at is
 * the signer's own claim), a key commitment when only the id's own
 * arithmetic does, never SOVEREIGN — and chain reads through Motebit's RPC
 * proxy, or a revocation scan that stopped at the page limit, never show as
 * anchored or as a revocation ✓. Any revocation memo found for the key is
 * reported, whatever its date against the claimed time. Any input change
 * clears the previous verdict at once; a verifier exception renders an explicit
 * "Not verified" state.
 */

import {
  verifyReceiptDocument,
  type ReceiptDocumentVerification,
} from "@motebit/state-export-client";
import { renderPending, renderResult, renderUnverifiable } from "./render.js";
import {
  assessVerdict,
  classifyRpc,
  observeSignatureScans,
  scansComplete,
  NO_BINDING_EVIDENCE,
  type BindingEvidence,
  type ChainEvidence,
} from "./assess.js";
import { checkServedChain, classifyId, idCommitsToKey } from "./served-chain.js";
import { canonicalKeyHexOfDid, noncanonicalFields } from "./canonical.js";
import { scanRevocationMemos } from "./memo-scan.js";
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
// Solana RPC for the anchor/revocation cross-checks: motebit's server-side
// passthrough, which holds the provider key. A provider URL is never a browser
// value (incident 2026-09-30); VITE_SOLANA_RPC_URL is a local-dev override only.
const SOLANA_RPC =
  import.meta.env.VITE_SOLANA_RPC_URL != null && import.meta.env.VITE_SOLANA_RPC_URL !== ""
    ? import.meta.env.VITE_SOLANA_RPC_URL
    : "https://api.motebit.com/v1/solana-rpc";
// Who answers those reads. The default is the operator's own proxy, so anything
// read through it is labelled and never earns ANCHORED or a revocation ✓.
const SOLANA_RPC_SOURCE = classifyRpc(SOLANA_RPC);

type Source = "sample" | "tampered-sample" | "minted" | "link" | "pasted";
const SOURCE_TEXT: Record<Source, string> = {
  sample: "sample — signed by a demo key",
  "tampered-sample": "sample, tampered — one byte of result flipped",
  minted: "minted here — demo key, generated in your browser, never sent anywhere",
  link: "from a shared link — the receipt stays in the URL fragment and is never uploaded",
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

/**
 * Remove whatever verdict is on screen. Called the instant the input changes
 * (typing, a share link, tamper, reset, mint) and at the start of every run, so
 * a verdict is never shown next to bytes it was not computed for.
 */
function clearResult(): void {
  resultContainer.replaceChildren(renderPending());
}

async function run(): Promise<void> {
  const text = input.value.trim();
  const seq = ++runSeq;
  if (text.length === 0) {
    if (emptyState) resultContainer.replaceChildren(emptyState);
    verifyBtn.disabled = false;
    return;
  }
  clearResult();
  verifyBtn.disabled = true;
  try {
    await verifyAndRender(text, seq, source);
  } catch (err) {
    // The verifier is meant never to throw; when it does (e.g. a malformed
    // delegation chain), fail closed with an explicit not-verified state.
    if (seq === runSeq) resultContainer.replaceChildren(renderUnverifiable(err));
  } finally {
    if (seq === runSeq) verifyBtn.disabled = false;
  }
}

async function verifyAndRender(text: string, seq: number, src: Source): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  let view: ReceiptDocumentVerification = await verifyReceiptDocument(text);
  let ctx: RelayContext;
  let evidence: ChainEvidence | undefined;
  const receipt = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    motebit_id?: unknown;
    public_key?: unknown;
    completed_at?: unknown;
  };
  // Every identity-bearing field the signer wrote, checked for exact canonical
  // form — even when integrity fails, so the copy never calls a re-spelled key
  // or signature forged.
  const noncanonical = noncanonicalFields(parsed);
  let keyEvidence: BindingEvidence = view.integrity
    ? {
        keyCommitsToId: await idCommitsToKey(receipt.motebit_id, receipt.public_key),
        idForm: classifyId(receipt.motebit_id),
        noncanonical,
      }
    : { ...NO_BINDING_EVIDENCE, noncanonical };
  if (src === "sample" || src === "tampered-sample") {
    ctx = offline("offline — the sample is verified in this tab, with no relay context");
  } else if (src === "minted") {
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
      // Measure the revocation scan: the verifier does not report whether it
      // reached the end of the address history or stopped at the page limit.
      const revocationScan = observeSignatureScans((i, init) => globalThis.fetch(i, init));
      view = await verifyReceiptDocument(text, {
        identity: resolved.identity,
        ...(resolved.anchor ? { anchor: resolved.anchor } : {}),
        revocation: {
          relayAnchorAddress: resolved.relayAnchorAddress,
          lookup: { rpcUrl: SOLANA_RPC, fetch: revocationScan.fetch },
        },
      });
      // The page's own scan, keyed on the DECODED key (the bytes the signature
      // verified under, read back from the verifier's did:key), so a memo is
      // found however the receipt spelled public_key — and reported even
      // without a usable date.
      const decodedKey = canonicalKeyHexOfDid(view.signerDid);
      const memoScan =
        decodedKey !== undefined
          ? await scanRevocationMemos(resolved.relayAnchorAddress, decodedKey, {
              rpcUrl: SOLANA_RPC,
              fetch: revocationScan.fetch,
            })
          : undefined;
      evidence = {
        source: SOLANA_RPC_SOURCE,
        revocationScanComplete: scansComplete(revocationScan.scans),
        ...(memoScan !== undefined ? { memoScan } : {}),
      };
      keyEvidence = {
        ...keyEvidence,
        servedChain: await checkServedChain(receipt, resolved.identity),
      };
      ctx = { kind: "resolved" };
    } else {
      ctx = {
        kind: "unavailable",
        reason: "the relay was unreachable or has no identity record for this motebit",
      };
    }
  }
  if (seq !== runSeq) return; // a newer edit superseded this run
  resultContainer.replaceChildren(
    renderResult(assessVerdict(view, evidence, keyEvidence), { receipt: parsed, ctx }),
  );
}

// ── Editing ──
let debounce: ReturnType<typeof setTimeout> | undefined;
input.addEventListener("input", () => {
  repaint();
  setSource(input.value === SAMPLE_JSON ? "sample" : "pasted");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  say("");
  // The old verdict goes now, not when the debounced run lands.
  runSeq++; // and any in-flight run for the previous text may no longer render
  clearResult();
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
