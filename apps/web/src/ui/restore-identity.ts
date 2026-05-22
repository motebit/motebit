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
 * natural filtering — old data is keyed to the prior motebit_id and
 * is invisible under the new identity); `preserveMemories=true` opts
 * into the cross-store re-key migration shipped in
 * `@motebit/browser-persistence`'s `migrateMotebitId`.
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
  openFromFile(): void;
  openFromSeed(): void;
}

interface RestoreState {
  metadata: ImportedIdentityMetadata | null;
  originalContent: string | null;
  derivedPrivateKeyHex: string | null;
  /** True when entered via "Restore from seed" — metadata is synthesized
   *  from the seed (the motebit_id is re-derived as the sovereign commitment
   *  to the recovered key) instead of read from a .md file, so the preview
   *  rendering surfaces a "re-derived motebit_id" banner. */
  seedOnly: boolean;
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

async function synthesizeSeedOnlyMetadata(publicKeyHex: string): Promise<ImportedIdentityMetadata> {
  // Re-derive the sovereign motebit_id from the recovered key, NOT a random UUID.
  // If the identity was sovereign-minted (the default), this IS its original id —
  // so seed-only restore actually recovers it. Legacy random-UUID identities get
  // a new sovereign id (their old random id is unrecoverable from the seed alone).
  const { deriveSovereignMotebitId } = await import("@motebit/crypto");
  return {
    motebitId: await deriveSovereignMotebitId(publicKeyHex),
    publicKey: publicKeyHex,
    ownerId: "Web",
    bornAt: new Date().toISOString(),
    devices: [],
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "R1_DRAFT",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    },
    memory: { half_life_days: 7, confidence_threshold: 0.3, per_turn_limit: 5 },
  };
}

export function initRestoreIdentity(ctx: WebContext): RestoreIdentityAPI {
  const backdrop = document.getElementById("restore-backdrop") as HTMLDivElement | null;
  const stepFile = document.getElementById("restore-step-file") as HTMLDivElement | null;
  const stepSeedOnly = document.getElementById("restore-step-seed-only") as HTMLDivElement | null;
  const stepPreview = document.getElementById("restore-step-preview") as HTMLDivElement | null;
  const preview = document.getElementById("restore-preview") as HTMLDivElement | null;
  const seedFieldGroup = document.getElementById(
    "restore-seed-field-group",
  ) as HTMLDivElement | null;
  const seedInput = document.getElementById("restore-seed") as HTMLInputElement | null;
  const seedStatus = document.getElementById("restore-seed-status") as HTMLDivElement | null;
  const seedOnlyInput = document.getElementById(
    "restore-seed-only-input",
  ) as HTMLInputElement | null;
  const seedOnlyStatus = document.getElementById(
    "restore-seed-only-status",
  ) as HTMLDivElement | null;
  const seedOnlyNext = document.getElementById(
    "restore-seed-only-next",
  ) as HTMLButtonElement | null;
  const confirmInput = document.getElementById("restore-confirm") as HTMLInputElement | null;
  const errorEl = document.getElementById("restore-error") as HTMLDivElement | null;
  const replaceBtn = document.getElementById("restore-replace") as HTMLButtonElement | null;
  const filePickBtn = document.getElementById("restore-file-pick") as HTMLButtonElement | null;
  const cancel0Btn = document.getElementById("restore-cancel-0") as HTMLButtonElement | null;
  const cancel1Btn = document.getElementById("restore-cancel-1") as HTMLButtonElement | null;
  const cancel2Btn = document.getElementById("restore-cancel-2") as HTMLButtonElement | null;
  const openMdBtn = document.getElementById("settings-restore-md") as HTMLButtonElement | null;
  const openSeedBtn = document.getElementById("settings-restore-seed") as HTMLButtonElement | null;

  if (
    !backdrop ||
    !stepFile ||
    !stepSeedOnly ||
    !stepPreview ||
    !preview ||
    !seedFieldGroup ||
    !seedInput ||
    !seedStatus ||
    !seedOnlyInput ||
    !seedOnlyStatus ||
    !seedOnlyNext ||
    !confirmInput ||
    !errorEl ||
    !replaceBtn ||
    !filePickBtn ||
    !cancel0Btn ||
    !cancel1Btn ||
    !cancel2Btn
  ) {
    // Markup missing — restore flow not wirable. Caller can still call
    // open*() but the dialog won't appear; this fail-quiet path matches
    // how the consent modal in capabilities.ts handles missing markup.
    return { openFromFile: () => undefined, openFromSeed: () => undefined };
  }

  const state: RestoreState = {
    metadata: null,
    originalContent: null,
    derivedPrivateKeyHex: null,
    seedOnly: false,
  };

  function reset(): void {
    state.metadata = null;
    state.originalContent = null;
    state.derivedPrivateKeyHex = null;
    state.seedOnly = false;
    seedInput!.value = "";
    seedOnlyInput!.value = "";
    confirmInput!.value = "";
    seedStatus!.textContent = "";
    seedStatus!.className = "restore-status";
    seedOnlyStatus!.textContent = "";
    seedOnlyStatus!.className = "restore-status";
    seedOnlyNext!.disabled = true;
    errorEl!.textContent = "";
    replaceBtn!.disabled = true;
    stepFile!.style.display = "none";
    stepSeedOnly!.style.display = "none";
    stepPreview!.style.display = "none";
    seedFieldGroup!.style.display = "";
    const preserveCheckbox = document.getElementById("restore-preserve") as HTMLInputElement | null;
    if (preserveCheckbox !== null) preserveCheckbox.checked = false;
  }

  function close(): void {
    backdrop!.classList.remove("open");
    reset();
  }

  function openFromFile(): void {
    reset();
    stepFile!.style.display = "";
    backdrop!.classList.add("open");
  }

  function openFromSeed(): void {
    reset();
    state.seedOnly = true;
    stepSeedOnly!.style.display = "";
    backdrop!.classList.add("open");
    seedOnlyInput!.focus();
  }

  function renderPreview(metadata: ImportedIdentityMetadata): void {
    const lines: string[] = [];
    if (state.seedOnly) {
      lines.push(
        `<div style="color: var(--status-warning, #f0a030); margin-bottom: 6px; font-family: -apple-system, BlinkMacSystemFont, sans-serif">⚠ Seed-only restore — motebit_id is re-derived from the seed. If your identity was sovereign (the default), this is your original id; a legacy random id can't be recovered from the seed alone.</div>`,
      );
    }
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
          errorEl.textContent = `Could not import — ${result.reason}`;
          return;
        }
        state.metadata = result.metadata;
        state.originalContent = content;
        renderPreview(result.metadata);
        stepFile.style.display = "none";
        stepPreview.style.display = "";
        seedInput.focus();
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

  const preserveCheckbox = document.getElementById("restore-preserve") as HTMLInputElement | null;

  replaceBtn.addEventListener("click", () => {
    if (state.metadata === null || state.derivedPrivateKeyHex === null) return;
    replaceBtn.disabled = true;
    errorEl.textContent = "";
    const preserveMemories = preserveCheckbox !== null && preserveCheckbox.checked;
    void ctx.app
      .restoreIdentity({
        privateKeyHex: state.derivedPrivateKeyHex,
        metadata: state.metadata,
        originalContent: state.originalContent ?? undefined,
        preserveMemories,
      })
      .then((result) => {
        if (result.ok) {
          window.location.reload();
        } else {
          errorEl.textContent = `Restore failed — ${result.reason}`;
          evaluateConfirm();
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        errorEl.textContent = `Restore failed — ${msg}`;
        evaluateConfirm();
      });
  });

  // Seed-only step: paste seed → derive public key → synthesize metadata
  // (motebit_id re-derived as the sovereign commitment to the recovered key)
  // → advance to preview. No metadata-side guard (the seed IS the authority);
  // the preview banner explains the id is re-derived from the seed.
  function evaluateSeedOnly(): void {
    const seedRaw = seedOnlyInput!.value.trim();
    seedOnlyNext!.disabled = true;
    if (seedRaw === "") {
      seedOnlyStatus!.textContent = "";
      seedOnlyStatus!.className = "restore-status";
      return;
    }
    if (seedRaw.length !== 64) {
      seedOnlyStatus!.textContent = `${seedRaw.length}/64 hex chars`;
      seedOnlyStatus!.className = "restore-status";
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(seedRaw)) {
      seedOnlyStatus!.textContent = "Seed must be 64 hex characters";
      seedOnlyStatus!.className = "restore-status err";
      return;
    }
    seedOnlyStatus!.textContent = "✓ Valid seed";
    seedOnlyStatus!.className = "restore-status ok";
    seedOnlyNext!.disabled = false;
  }
  let seedOnlyDebounce: ReturnType<typeof setTimeout> | null = null;
  seedOnlyInput.addEventListener("input", () => {
    if (seedOnlyDebounce) clearTimeout(seedOnlyDebounce);
    seedOnlyDebounce = setTimeout(() => {
      evaluateSeedOnly();
    }, 150);
  });
  seedOnlyNext.addEventListener("click", () => {
    const seedRaw = seedOnlyInput.value.trim();
    if (seedRaw.length !== 64 || !/^[0-9a-fA-F]+$/.test(seedRaw)) return;
    void (async () => {
      try {
        const { hexToBytes, bytesToHex, getPublicKeyBySuite } = await import("@motebit/encryption");
        const privBytes = hexToBytes(seedRaw);
        const pubBytes = await getPublicKeyBySuite(privBytes, "motebit-jcs-ed25519-hex-v1");
        const pubHex = bytesToHex(pubBytes);
        const synthesized = await synthesizeSeedOnlyMetadata(pubHex);
        state.metadata = synthesized;
        state.originalContent = null;
        state.derivedPrivateKeyHex = seedRaw;
        renderPreview(synthesized);
        stepSeedOnly.style.display = "none";
        stepPreview.style.display = "";
        // In seed-only mode the seed has already been collected upstream;
        // hide the preview-step's seed input so we don't re-ask for it.
        seedFieldGroup.style.display = "none";
        confirmInput.focus();
        evaluateConfirm();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        seedOnlyStatus.textContent = `Could not derive key — ${msg}`;
        seedOnlyStatus.className = "restore-status err";
      }
    })();
  });

  cancel0Btn.addEventListener("click", close);
  cancel1Btn.addEventListener("click", close);
  cancel2Btn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdrop.classList.contains("open")) close();
  });

  openMdBtn?.addEventListener("click", openFromFile);
  openSeedBtn?.addEventListener("click", openFromSeed);

  return { openFromFile, openFromSeed };
}
