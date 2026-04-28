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
  1. IdentityManager.create(surfaceName) → UUID v7 motebit_id
  2. generateKeypair()                   → Ed25519 pub/priv
  3. IdentityManager.registerDevice()    → device_id + device_token
  4. keyStore.storePrivateKey(hex)        → surface persists key
  5. configStore.write(metadata)          → surface persists config
  6. return { motebitId, deviceId, publicKeyHex, isFirstLaunch: true }
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
- **Desktop:** OS keyring via Tauri
- **Mobile (future):** expo-secure-store (iOS Keychain / Android Keystore)
- **Spatial (future):** localStorage (WebCrypto wrapping recommended)

## Canonical output

Every surface produces the same shape:

| Field          | Format                | Example                                |
| -------------- | --------------------- | -------------------------------------- |
| `motebitId`    | UUID v7               | `019726a3-4f8b-7e12-8a9c-1d2e3f4a5b6c` |
| `deviceId`     | UUID v4               | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `publicKeyHex` | 64-char lowercase hex | `aabbccdd...` (32 bytes Ed25519)       |

The cross-surface canonicality test in `src/__tests__/bootstrap.test.ts` enforces this invariant.

## Lint enforcement

An ESLint `no-restricted-imports` rule in `.eslintrc.js` bans `generateKeypair` imports from `@motebit/crypto` in all `apps/` and `services/` directories. Surfaces that haven't migrated yet have explicit `eslint-disable` comments with TODO markers.
