---
"@motebit/desktop": minor
---

Machine roster C-2c: the desktop's Machines section (`docs/proposals/machine-roster-surfaces-v1.md`, §1B then §1A over §1), on the shared kit from C-2a.

**Storage.** One desktop-owned file, `~/.motebit/machine-roster.desktop.json` (never the CLI's `machine-roster.json`), holding one replica and one presentation record per motebit id. Two new Tauri commands move its bytes: `roster_replica_read` (bytes and digest) and `roster_replica_write`, a compare-and-swap on the digest under an in-process mutex and an OS file lock, written atomically (staged, fsync, rename, fsync dir). Every save is read, merge, compare-and-swap, retried on a conflict, so a second desktop process never writes over a retirement it did not see. An unreadable file is kept as `.corrupt-<time>` before anything replaces it. The kit's `exclusive` is a lease (`roster_lease_acquire` / `roster_lease_release`): an OS lock held by the Rust process, with an owner token and a timeout, so a reloaded webview or a crash never leaves it held.

**Roster.** `MachineRoster.gated` with `selfIsHost: false`: no enrol-on-announce and no rotation capture; `enroll` of this machine's own id goes through the kit's R17 refusals (its machine may be a CLI host) and records no own mint. The signer is `device_private_key` from `dev-keyring.json`; the roster routes carry a `device:auth` token minted over the same bytes, never the master token. `storedPublicKeyHex` and `rotationInFlight` come from the desktop's own key store. The config's motebit.md is a succession-record source only when it verifies, names this motebit and its current key is the held key; no guardian is ever pinned locally.

**Presentation.** On every sync connect, when due (changed, or ten minutes). A `Retry-After` is stored, and every entry point re-reads it before the kit acquires, so a fresh process never presents or repairs an omission inside a pending one.

**Lifecycle.** The roster is disposed before a restore or a pairing writes to the key store (none until reload after a restore; a new one for the new identity after a pairing), and on stop (none until start). A disposed roster reads no key.

**Rotation.** The commit appends its succession link to the replica after the key is stored; a roster failure never fails the rotation. The Rotate dialog states the cost: machines need enrolling again under the new key.

No published package changes.
