# @motebit/core-identity

Identity ownership for the motebit agent.

## Who owns bootstrap?

This package. Every agent-bearing surface — CLI, Desktop, Mobile, Spatial — must bootstrap identity through `bootstrapIdentity()`. No surface generates its own keypairs or registers its own devices.

### Must use `bootstrapIdentity`

Any surface that:

- Runs `MotebitRuntime` locally
- Needs to authenticate as a device under an owner identity
- Can execute tools, access memory, or sync

**Current:** CLI, Desktop. **Future:** Mobile, Spatial.

### Should not use it

Observer surfaces that don't run an agent, don't own keys, and only view an existing motebit via API tokens (e.g. Inspector dashboard).

## The bootstrap protocol

```
configStore.read()
  ├─ identity exists in config + DB → return existing (isFirstLaunch: false)
  ├─ identity in config but not DB  → re-create in DB, then first-launch flow
  └─ no identity                    → first-launch flow

First-launch flow:
  1. generateKeypair()                   → Ed25519 pub/priv
  2. deriveSovereignMotebitId(pubHex)    → UUIDv8 motebit_id (commits to the key)
  3. IdentityManager.createWithId(id)    → identity row
  4. IdentityManager.registerDevice()    → device_id + device_token
  5. configStore.write(metadata)          → surface persists config
  6. keyStore.storePrivateKey(hex)        → surface persists key
  7. return { motebitId, deviceId, publicKeyHex, isFirstLaunch: true }
```

## Adapter contracts

Surfaces implement two interfaces to inject their platform-specific I/O:

### `BootstrapConfigStore`

```typescript
interface BootstrapConfigStore {
  read(): Promise<{ motebit_id: string; device_id: string; device_public_key: string } | null>;
  write(state: { motebit_id: string; device_id: string; device_public_key: string }): Promise<void>;
}
```

- **CLI:** Reads/writes `~/.motebit/config.json`
- **Desktop:** Tauri IPC (`read_config` / `write_config`)
- **Mobile (future):** AsyncStorage or expo-secure-store
- **Spatial (future):** localStorage or IndexedDB

### `BootstrapKeyStore`

```typescript
interface BootstrapKeyStore {
  storePrivateKey(privKeyHex: string): Promise<void>;
}
```

- **CLI:** PBKDF2 + AES-256-GCM encryption, stored in config
- **Desktop:** `~/.motebit/dev-keyring.json` via Tauri (owner-only, plaintext; the OS keychain is a pending arc, #764)
- **Mobile (future):** expo-secure-store (iOS Keychain / Android Keystore)
- **Spatial (future):** localStorage (WebCrypto wrapping recommended)

## Canonical output

Every surface produces the same shape:

| Field          | Format                | Example                                |
| -------------- | --------------------- | -------------------------------------- |
| `motebitId`    | UUIDv8 (key-derived)  | `3f2a9c1e-7b40-8d15-9e6a-0c4b2d8f1a37` |
| `deviceId`     | UUID v4               | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `publicKeyHex` | 64-char lowercase hex | `aabbccdd...` (32 bytes Ed25519)       |

The cross-surface canonicality test in `src/__tests__/bootstrap.test.ts` enforces this invariant.

## Lint enforcement

An ESLint `no-restricted-imports` rule in `.eslintrc.js` bans `generateKeypair` imports from `@motebit/crypto` in all `apps/` and `services/` directories. Surfaces that haven't migrated yet have explicit `eslint-disable` comments with TODO markers.
