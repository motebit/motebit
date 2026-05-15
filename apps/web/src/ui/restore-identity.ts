/**
 * Restore-identity controller — web. Wires the multi-step replace-identity
 * flow on the Settings → Identity tab.
 *
 * Three layers compose:
 *
 *   1. `WebApp.importMotebitMd(content)` — parse + verify, returns flat
 *      metadata. Pure read.
 *   2. UI-side guard: user pastes recovery seed → derive its public key
 *      via `getPublicKeyBySuite` → compare to `metadata.publicKey`. Match
 *      is the precondition for any restore-button enable.
 *   3. `WebApp.restoreIdentity({ privateKeyHex, metadata, originalContent,
 *      preserveMemories })` — side-effecting. Writes keystore + config,
 *      returns `{ ok: true, needsReload: true }` on success. UI reloads.
 *
 * Per [[identity_restore_arc]] design call #1 (coexistence guard): hard
 * overwrite + type-to-confirm `REPLACE IDENTITY` is the contract.
 * Per design call #3 (memories on replace): default clears (via
 * orphaning today; explicit wipe + re-key path lands when
 * preserveMemories=true ships). The checkbox is rendered disabled with
 * a "coming soon" label until then.
 *
 * Sibling-boundary doctrine: desktop and mobile mirror this flow with
 * the same three-layer split. The package primitives
 * (`importIdentityFile`, `validateRestoreRequest`,
 * `RestoreIdentityRequest`) live in `@motebit/identity-file` so all
 * three surfaces consume one contract.
 */

import type { ImportedIdentityMetadata } from "@motebit/identity-file";

import type { WebContext } from "../types";

export interface RestoreIdentityAPI {
  open(): void;
}

interface RestoreState {
  metadata: ImportedIdentityMetadata | null;
  originalContent: string | null;
  derivedPrivateKeyHex: string | null;
}

function relativeBornAt(bornAt: string): string {
  const ms = Date.now() - Date.parse(bornAt);
  if (!Number.isFinite(ms)) return bornAt;
  const days = Math.floor(ms / 86400000);
  if (days < 0) return bornAt;
  if (days < 1) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function shortAddress(pubHex: string): string {
  if (pubHex.length < 12) return pubHex;
  return `${pubHex.slice(0, 6)}…${pubHex.slice(-4)}`;
}

export function initRestoreIdentity(ctx: WebContext): RestoreIdentityAPI {
  const backdrop = document.getElementById("restore-backdrop") as HTMLDivElement | null;
  const stepFile = document.getElementById("restore-step-file") as HTMLDivElement | null;
  const stepPreview = document.getElementById("restore-step-preview") as HTMLDivElement | null;
  const preview = document.getElementById("restore-preview") as HTMLDivElement | null;
  const seedInput = document.getElementById("restore-seed") as HTMLInputElement | null;
  const seedStatus = document.getElementById("restore-seed-status") as HTMLDivElement | null;
  const confirmInput = document.getElementById("restore-confirm") as HTMLInputElement | null;
  const errorEl = document.getElementById("restore-error") as HTMLDivElement | null;
  const replaceBtn = document.getElementById("restore-replace") as HTMLButtonElement | null;
  const filePickBtn = document.getElementById("restore-file-pick") as HTMLButtonElement | null;
  const cancel1Btn = document.getElementById("restore-cancel-1") as HTMLButtonElement | null;
  const cancel2Btn = document.getElementById("restore-cancel-2") as HTMLButtonElement | null;
  const openBtn = document.getElementById("settings-restore-md") as HTMLButtonElement | null;

  if (
    !backdrop ||
    !stepFile ||
    !stepPreview ||
    !preview ||
    !seedInput ||
    !seedStatus ||
    !confirmInput ||
    !errorEl ||
    !replaceBtn ||
    !filePickBtn ||
    !cancel1Btn ||
    !cancel2Btn
  ) {
    // Markup missing — restore flow not wirable. Caller can still call
    // open() but the dialog won't appear; this fail-quiet path matches
    // how the consent modal in capabilities.ts handles missing markup.
    return { open: () => undefined };
  }

  const state: RestoreState = {
    metadata: null,
    originalContent: null,
    derivedPrivateKeyHex: null,
  };

  function reset(): void {
    state.metadata = null;
    state.originalContent = null;
    state.derivedPrivateKeyHex = null;
    seedInput!.value = "";
    confirmInput!.value = "";
    seedStatus!.textContent = "";
    seedStatus!.className = "restore-status";
    errorEl!.textContent = "";
    replaceBtn!.disabled = true;
    stepFile!.style.display = "";
    stepPreview!.style.display = "none";
  }

  function close(): void {
    backdrop!.classList.remove("open");
    reset();
  }

  function open(): void {
    reset();
    backdrop!.classList.add("open");
  }

  function renderPreview(metadata: ImportedIdentityMetadata): void {
    const lines: string[] = [];
    lines.push(
      `<div><span class="restore-preview-label">motebit</span>${metadata.motebitId.slice(0, 12)}…</div>`,
    );
    lines.push(
      `<div><span class="restore-preview-label">Born</span>${relativeBornAt(metadata.bornAt)}</div>`,
    );
    lines.push(
      `<div><span class="restore-preview-label">Solana</span>◆ ${shortAddress(metadata.publicKey)}</div>`,
    );
    preview!.innerHTML = lines.join("");
  }

  filePickBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,text/markdown,text/plain";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(async (content) => {
        const result = await ctx.app.importMotebitMd(content);
        if (!result.valid) {
          errorEl!.textContent = `Could not import — ${result.reason}`;
          return;
        }
        state.metadata = result.metadata;
        state.originalContent = content;
        renderPreview(result.metadata);
        stepFile!.style.display = "none";
        stepPreview!.style.display = "";
        seedInput!.focus();
      });
    });
    input.click();
  });

  async function evaluateSeed(): Promise<void> {
    const seedRaw = seedInput!.value.trim();
    state.derivedPrivateKeyHex = null;
    replaceBtn!.disabled = true;
    if (seedRaw === "") {
      seedStatus!.textContent = "";
      seedStatus!.className = "restore-status";
      return;
    }
    if (seedRaw.length !== 64) {
      seedStatus!.textContent = `${seedRaw.length}/64 hex chars`;
      seedStatus!.className = "restore-status";
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(seedRaw)) {
      seedStatus!.textContent = "Seed must be 64 hex characters";
      seedStatus!.className = "restore-status err";
      return;
    }
    if (state.metadata === null) return;
    try {
      const { hexToBytes, bytesToHex, getPublicKeyBySuite } = await import("@motebit/encryption");
      const privBytes = hexToBytes(seedRaw);
      const pubBytes = await getPublicKeyBySuite(privBytes, "motebit-jcs-ed25519-hex-v1");
      const derivedPubHex = bytesToHex(pubBytes);
      if (derivedPubHex.toLowerCase() === state.metadata.publicKey.toLowerCase()) {
        seedStatus!.textContent = "✓ Seed matches this identity";
        seedStatus!.className = "restore-status ok";
        state.derivedPrivateKeyHex = seedRaw;
        evaluateConfirm();
      } else {
        seedStatus!.textContent = "Seed does not match this motebit.md (different identity)";
        seedStatus!.className = "restore-status err";
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      seedStatus!.textContent = `Could not derive key — ${msg}`;
      seedStatus!.className = "restore-status err";
    }
  }

  function evaluateConfirm(): void {
    const matchesSeed = state.derivedPrivateKeyHex !== null;
    const matchesPhrase = confirmInput!.value.trim() === "REPLACE IDENTITY";
    replaceBtn!.disabled = !(matchesSeed && matchesPhrase);
  }

  let seedDebounce: ReturnType<typeof setTimeout> | null = null;
  seedInput.addEventListener("input", () => {
    if (seedDebounce) clearTimeout(seedDebounce);
    seedDebounce = setTimeout(() => {
      void evaluateSeed();
    }, 150);
  });
  confirmInput.addEventListener("input", evaluateConfirm);

  replaceBtn.addEventListener("click", () => {
    if (state.metadata === null || state.derivedPrivateKeyHex === null) return;
    replaceBtn!.disabled = true;
    errorEl!.textContent = "";
    void ctx.app
      .restoreIdentity({
        privateKeyHex: state.derivedPrivateKeyHex,
        metadata: state.metadata,
        originalContent: state.originalContent ?? undefined,
        preserveMemories: false,
      })
      .then((result) => {
        if (result.ok) {
          window.location.reload();
        } else {
          errorEl!.textContent = `Restore failed — ${result.reason}`;
          evaluateConfirm();
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        errorEl!.textContent = `Restore failed — ${msg}`;
        evaluateConfirm();
      });
  });

  cancel1Btn.addEventListener("click", close);
  cancel2Btn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdrop.classList.contains("open")) close();
  });

  openBtn?.addEventListener("click", open);

  return { open };
}
