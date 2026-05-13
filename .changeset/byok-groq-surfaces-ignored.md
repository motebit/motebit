---
---

**Surface-side companion to the BYOK Groq SDK addition** (see `.changeset/byok-groq-vendor.md`). All four chat surfaces (web, desktop, mobile, CLI) gain a Groq tile per CLAUDE.md's one-pass-delivery principle. Mechanical template-match against the DeepSeek slice from earlier today; same shape on every surface.

**Web** (`apps/web/index.html` + `apps/web/src/ui/settings.ts`):

- Fifth `byok-provider-btn` (data-byok="groq") added to the BYOK selector row.
- `#byok-groq` section with API key input (`gsk_...` placeholder) + model select with two options (`llama-3.3-70b-versatile`, `openai/gpt-oss-120b`).
- `activeByokProvider` union extended to include `"groq"`; toggle handler, `setByokProviderUI`, load + save paths all gain the groq arm.
- Calm-software register: pre-filled defaults + terse value-prop note ("Meta Llama 3.3 70B via Groq's LPU inference — fastest American open-source option (~280 tok/sec). ~5× cheaper than American closed-source alternatives.") at 11px under the API key input.

**Desktop** (`apps/desktop/`):

- `DesktopProvider` union extended with `"groq"`.
- `desktopConfigToUnified` gains the `groq` arm.
- `byokKeyringKey` returns the new `groq_api_key` keyring slot; `GROQ_API_KEY_SLOT` declared in `keyring-keys.ts`.
- Settings UI: fifth tile in the BYOK row; `activeByokVendor` union extended; `populateByokModeModels` + `populateModelSelect` route Groq to `GROQ_MODELS`.

**Mobile** (`apps/mobile/`):

- `MobileProvider` + `ProviderType` unions extended with `"groq"`.
- Both `mobileConfigToUnified` AND `mobileSettingsToUnifiedProvider` gain the `groq` arm (two parallel byok converters in mobile-app.ts — both need updates).
- `IntelligenceTab.tsx`: fifth `TouchableOpacity` radio button + conditional API-key input section with the calm-default value-prop note.
- `SettingsModal.tsx`: `groqKey` state, `SECURE_STORE_KEYS.groqApiKey` load/save, prop passthrough, dependency array updated.
- `storage-keys.ts`: `groqApiKey: "motebit_groq_api_key"` SecureStore slot.

**CLI** (`apps/cli/`):

- `CliProvider` union extended with `"groq"`; `VALID_PROVIDERS` array updated.
- `getApiKey("groq")` reads `GROQ_API_KEY` env var with proper error-message hint (`gsk_...`).
- Default model fallback returns `"llama-3.3-70b-versatile"` when `--provider groq`.
- `cliConfigToUnified` parallel-shaped arm in `runtime-factory.ts`.

**No new drift gates needed.** The existing closure discipline already enforces the addition:

- TypeScript exhaustive-switch typecheck on the four `*Provider` / `ByokVendor` unions
- `check-api-surface` (SDK baseline mirrors the union)
- The provider-resolver tests (one describe block per vendor — now 5)

Same calm-software register as the DeepSeek slice — just an additional tile in the existing BYOK row on each surface. No new tabs, no new modals.
