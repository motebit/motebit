---
"@motebit/mobile": minor
---

Machine roster C-2b: the phone's Machines section (`docs/proposals/machine-roster-surfaces-v1.md`, §1B then §1A over §1), on the shared kit from C-2a.

**Storage.** One AsyncStorage key per motebit (`@motebit/machine_roster/<motebit_id>`), so a pairing or restore never inherits or destroys another identity's replica. Each save runs on its own in-process promise chain (get, set a corrupt value aside to `…/<id>.corrupt-<t>`, merge, set), separate from the kit's `exclusive` chain, so two saves never lose each other's retirement. A corrupt value is kept aside before anything is written over it.

**Roster.** `MachineRoster.gated` with `selfIsHost: false`: no enrol-on-announce, no rotation capture, and `enroll` of this phone's own id is refused ("This device is not a host."). The signer is the SecureStore key; the roster routes carry a `device:auth` token minted over the same bytes, never a master token. The stored motebit.md is a succession-record source and a guardian pin only when it verifies and names this motebit. A legacy identity whose relay names no key shows lines, no count and no actions; a device-only key shows only the reason.

**Presentation.** On every sync connect, when the replica changed since the last presentation the relay fully took or at most every ten minutes; a 429's `Retry-After` holds every presentation, an act's own included.

**Rotation.** The commit appends its succession link to the replica after the key is stored; a roster failure never fails the rotation. The Rotate confirmation states the cost: machines need enrolling again under the new key.

**Settings.** Settings → Identity gains a Machines section (Retire without confirmation, Enroll per F6 with a second tap for `needs-force`, results inline, no toasts). The roster is disposed on a pairing that switches identity, on restore (none until reload) and on stop.

No published package changes.
