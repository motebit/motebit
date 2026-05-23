# Identity restore

**You own the identity, so you can also reclaim it.** Restore-from-backup is the missing half of identity export. Without it, "you own your motebit" carries an asterisk: _as long as your device's keystore stays intact_. The arc that shipped 2026-05-15 closes that asterisk on every flat surface.

This doctrine codifies the architectural shape of the restore flow, the cross-surface invariants that make it composable, and the design calls baked into the v1 contract.

## Three-layer split

Restore composes three primitives across two layers:

1. **`importIdentityFile(content)`** in `@motebit/identity-file` — pure read. Parse the YAML frontmatter, verify the Ed25519 signature chain via the suite-dispatched `verify()` in `@motebit/crypto`, return flat `ImportedIdentityMetadata` (`motebitId`, `publicKey`, `bornAt`, `devices`, `governance`, `memory`). No side effects.

2. **`validateRestoreRequest(request)`** in `@motebit/identity-file` — cryptographic guard, no side effects. Derives the public key from the supplied private key via `getPublicKeyBySuite(privBytes, "motebit-jcs-ed25519-hex-v1")` and compares it to `metadata.publicKey`. Mismatch → `"key_mismatch"`. Also enforces the typed reasons for length and hex format. The `preserve_not_implemented` reason stays in the union for surfaces that haven't shipped the re-key migration, but validate stopped gating on it once web / desktop / mobile each landed their per-surface migration — each surface handles `preserveMemories` locally now.

3. **`restoreIdentity(request)`** per surface (`WebApp` / `IdentityManager` on desktop / `MobileApp`) — side-effecting. Writes the private key to the surface's keystore, writes the new `motebit_id` / `device_id` / `device_public_key` to the surface's config store, returns `{ ok: true, motebitId, needsReload: true }` on success. Each surface owns its own keystore + config-store adapter (web IDB + localStorage; desktop OS keyring + Tauri config file; mobile Expo SecureStore). The UI calls reload on `needsReload`; the next bootstrap reads the new keystore + config and brings up the runtime under the restored identity.

The split exists because **(1)** is browser-and-native-safe (zero `node:*` deps; `@motebit/crypto` is the permissive-floor verifier), **(2)** is the central guard rail every surface must run before any write, and **(3)** is the only layer that touches per-surface storage adapters. Without the split, surface drift creeps in: one surface might skip the public-key check, another might write the keystore before the config and crash mid-restore. The split eliminates the drift class by making the validation pure and the storage write structural.

## Cross-surface invariants

These hold on every surface that exposes restore:

- **Every surface has both `importMotebitMd`/`importIdentityFile` and `restoreIdentity` methods on its app class.** Restore depends on import; shipping one without the other leaves the user with a half-flow. The naming follows each surface's local convention (web/mobile use `Md` suffix; desktop uses `IdentityFile`) — the contract is preserved, the spelling matches the surface's neighbors.
- **The UI's "Replace identity" button is gated on `derivedPublicKey === metadata.publicKey` AND `confirmInput === "REPLACE IDENTITY"`.** Both gates must hold simultaneously. The first is cryptographic (the seed must agree with the .md); the second is intentional (type-to-confirm). Either alone is insufficient. This is hard overwrite per [[identity_restore_arc]] design call #1 — coexistence is out of scope until identity-list UI ships.
- **The Restore section sits below the Identity File section in Settings → Identity, never above.** Identity ID → Export → Restore is the reading order; restore is the recovery affordance, not the primary action.
- **`preserveMemories=false` is the default on every surface.** The checkbox is opt-in, labelled with the explicit "Severs cryptographic chain to original signing identity" trade-off; the re-key migration shipped 2026-05-15 and is documented in § "Deferred items" below. Per design call #3: clear-by-default; the opt-in path is additive, not the spine.

## Two entry points

Restore has two user-facing entry points sharing one downstream contract:

- **Restore from motebit.md** — file picker → `importIdentityFile(content)` returns metadata + the original signed .md → user pastes recovery seed → derived public key compared to `metadata.publicKey` → type-to-confirm → `restoreIdentity({ privateKeyHex, metadata, originalContent, preserveMemories: false })`. The original .md rides through as `originalContent` so desktop's `_identity_file` config slot preserves the cryptographic governance anchor. Web and mobile ignore the field (their governance config doesn't live in a `_identity_file` slot).
- **Restore from recovery seed** — no file picker. User pastes seed → derive public key → **synthesize** minimal `ImportedIdentityMetadata` whose motebit_id is **re-derived as the sovereign commitment to the recovered key** (`deriveSovereignMotebitId(publicKey)`, NOT a random UUID), bornAt = now, empty devices, default governance/memory → type-to-confirm → `restoreIdentity(...)` with `originalContent: undefined`. Because minting is sovereign-by-default, this recovers the **original** motebit_id from the seed alone — the whole point of the sovereign rung. (A legacy pre-sovereign random id can't be recovered this way; it was never a commitment to the seed, so seed-only restore yields a fresh sovereign id and the preview surfaces a banner saying so.) All three surfaces (`apps/web`, `apps/desktop`, `apps/mobile`) re-derive identically. Desktop clears the stale `_identity_file` from config; bootstrap regenerates one on next launch.

**Seed-only restore inherently mints a new `motebit_id`.** The UUID v7 was generated independently at first launch and is not derivable from the keypair. The cryptographic identity (private key + Solana address + fund reclaim) is preserved; the brand identity is regenerated. The UI surfaces this honestly with a warning banner in the preview step: _"⚠ Seed-only restore — original motebit_id not recoverable, a new one will be assigned."_

This is a real semantic split, not a UI cosmetic: the motebit.md path is _full identity bundle_ restore (history + signature chain + brand intact); the seed-only path is _cryptographic key + funds_ restore (brand fresh). Different recovery scenarios, different guarantees, one downstream `restoreIdentity` primitive.

## The keystore-probe relationship

`hasPrivateKey()` divergence-detection on the keystore was reverted earlier this arc (per [[feedback_sovereignty_primitives_audit_consumers]]) because `bootstrapIdentity` would silently orphan the user's funds, credentials, and trust if config and keystore diverged. With the restore arc shipped, the probe is now safe — the user follows a non-destructive recovery path:

> "Your local identity material has diverged. Restore from your motebit.md or recovery seed to recover."

The probe + restore are co-load-bearing. Either alone is hostile (probe-without-restore = forced data loss; restore-without-probe = no entry point for the user to discover they need to restore). The pair is intelligible.

**Implementation (shipped 2026-05-15 in the same session as the restore arc):**

1. **Typed divergence signal** — `BootstrapResult.divergedFromMotebitId?: string` in `@motebit/core-identity`. Bootstrap still auto-recovers (preserving backward compat for non-UI consumers like the CLI and file-stores), but reports the orphaned motebit_id back to the caller. Old callers that ignore the field keep the legacy silent-re-mint behavior; new surfaces that read it can render recovery UI.
2. **Per-surface divergence banner / Alert** — `WebApp.divergedFromMotebitId` + `DesktopApp.divergedFromMotebitId` + `MobileApp.divergedFromMotebitId` all surface the signal to a UI affordance: web/desktop render a fixed-top banner with three CTAs (Restore from motebit.md / Restore from seed / Dismiss); mobile fires `Alert.alert` with two CTAs (Restore Identity / Dismiss) that route into the SettingsModal Identity tab. The "Dismiss" path calls `clearDivergenceNotice()` to accept the auto-minted fresh identity — making the silent re-mint explicit, not default.
3. **Web `EncryptedKeyStore.hasPrivateKey()` finally exposed** — the IDB-WebCrypto path probes the keystore IDB for the canonical record; the localStorage fallback probes the cipher key. Never throws; storage-backend errors surface as `false` so bootstrap routes to recovery instead of wedging.

The cross-surface invariant is structural: every surface has BOTH a divergence-detection primitive AND a divergence-recovery surface. The contract is documented in `BootstrapResult` type comments and enforced by TypeScript at every surface's bootstrap call site.

## Deferred items (v1.x targets)

These are honest gaps in the v1 ship, each documented inline at its blocker site:

- ~~**`preserveMemories=true` re-key migration.**~~ **Shipped 2026-05-15** in the same session as the keystore-probe re-exposure. The four memory-shaped stores (`conversations`, `memory_nodes`, `plans`, `agent_trust`) re-key from old to new motebit_id; signed-trail stores (`events`, `audit_log`, `issued_credentials`, `identities`, `devices`) stay orphaned by design so their cryptographic chains keep telling the truth about authorship. Per-surface primitives: `migrateMotebitId` in `@motebit/browser-persistence` (IDB), `migrateMotebitIdSql` in `apps/desktop/src/tauri-storage.ts` (Tauri SQL), `migrateMotebitIdExpo` in `apps/mobile/src/adapters/expo-sqlite.ts` (expo-sqlite). The doctrinal split — which stores are content vs which are signed claims — lives in the file doc on `packages/browser-persistence/src/migrate-motebit-id.ts`.
- ~~**Born-date fidelity.**~~ **Shipped 2026-05-15** in the same session as the rest of the restore arc. The package-level helper `writeRestoredIdentity` in `@motebit/core-identity` pre-writes the `MotebitIdentity` record + `IdentityCreated` event with the historical bornAt before the surface reload, so bootstrap's "loaded" early-return fires and the Date.now() auto-recover path doesn't. Each surface (`WebApp.restoreIdentity`, `IdentityManager.restoreIdentity` on desktop, `MobileApp.restoreIdentity`) calls the helper as a best-effort step after the preserveMemories migration and before the keystore/config writes — failure is non-fatal (bootstrap's auto-recover path still fires Date.now() in that case; the user sees "Born today" instead of the original date but the identity is otherwise intact). Seed-only restore (which synthesizes `bornAt: new Date().toISOString()`) gives the legacy behavior naturally — there's no historical bornAt to preserve when the seed alone is the input.
- ~~**`hasPrivateKey()` re-exposure.**~~ **Shipped 2026-05-15** in the same session as the restore arc. See § "The keystore-probe relationship" above for the implementation.
- **Solana balance in the preview.** The .md path could fetch live USDC balance for the derived Solana address as a sanity check. v1 shows the address only; users can paste it into Solscan or Phantom externally. Deferred — adds network dependency to the restore UX for marginal value.

## Citation graph

This doctrine sits at the intersection of several earlier commitments. Each is load-bearing on the shape that landed:

- [`protocol-primacy.md`](protocol-primacy.md) — restore-from-backup is a protocol-level property; works identically for users who never subscribe to motebit-cloud. The .md file is structurally public; the seed is the only authority; neither requires the relay. _"Does this work for a user who never subscribes?"_ — yes, every restore path runs entirely on-device.
- [`receipts-unified.md`](receipts-unified.md) — restored memories under a new motebit_id sever the cryptographic chain to receipts signed by the prior identity. This is the doctrine-pure framing of why `preserveMemories=true` requires explicit consent.
- [`agility-as-role.md`](agility-as-role.md) — the suite dispatch (`getPublicKeyBySuite(privBytes, "motebit-jcs-ed25519-hex-v1")`) routes through the same registry every other signing surface uses. Post-quantum key derivation is a registry append, not a restore-flow rewrite.
- [`self-attesting-system.md`](self-attesting-system.md) — every claim is user-verifiable. The pasted .md is verified against its embedded signature; the pasted seed is verified by deriving a public key and comparing. The user can fully audit the restore decision before confirming.
