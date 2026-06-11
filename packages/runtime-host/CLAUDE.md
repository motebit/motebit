# @motebit/runtime-host

The runtime-host election + attach protocol: one coordinator runtime per machine, every other motebit process attaches as a frontend. Implements increment 1 of [`docs/doctrine/daemon-desktop-unification.md`](../../docs/doctrine/daemon-desktop-unification.md).

Layer 1. BUSL-1.1. Deps: `@motebit/protocol` (the `runtime:attach` audience), `@motebit/crypto` (signed-token mint/verify). Node `net`/`fs` only — no storage, no runtime import.

## Rules

1. **The bind is the truth; the lockfile is advisory.** Election order is attach-first → PID-probe grace → takeover-and-bind. Never decide coordinatorship from the lockfile alone, and never unlink a socket that accepts connections (only a connect-refused path, which provably has no listener).
2. **Handshake is fail-closed.** Pre-`hello` traffic, malformed frames, unknown devices, wrong identity, wrong audience, bad signatures, expired tokens, key-resolution _errors_ — all refuse or destroy. Version skew refuses with both versions named, never degrades silently.
3. **`AttachRefusedError` is an answer, not an invitation.** A live coordinator refusing the handshake must never trigger a bind-over. The election rethrows it untouched.
4. **Device-key resolution is an injected port.** `resolveDevicePublicKey(deviceId)` — the package never binds to a storage layer or the relay's identity manager. Hosting processes wire their own device store.
5. **The invoke seam carries typed capabilities only.** Hosting processes wire `onInvoke` to the runtime's `invokeCapability`, never to a constructed prompt (`docs/doctrine/surface-determinism.md`). Frontend disconnect aborts the in-flight invocation via the handler's `signal`.
6. **Fail-loud across the authority boundary.** Coordinator EOF rejects in-flight invocations to their origin frontend and fires `onClose` (the re-elect signal). No silent retry.
7. **The token never leaves the machine.** `runtime:attach` is verified here and only here; the relay and every network verifier reject it by audience binding.

## What NOT to add

- Live coordinator handover. Deliberately out of v1 (capability bridging makes the election outcome neutral); the named trigger to revisit is in the doctrine doc.
- Policy, signing, or receipt logic. The coordinator _serializes_ those through the hosting process's runtime; this package is transport plus the authentication boundary.
- Network transports. The endpoint is a unix domain socket / Windows named pipe by construction; remote ingress is increment 4's signed-envelope work, not a socket option here.

## Consumers

- `apps/cli` (increment 2, shipped) — daemon + `motebit serve` bind (refusing honestly when a coordinator is live); the REPL attaches as a rendering frontend (chat / invoke / approval proxying via `apps/cli/src/runtime-host.ts`, which owns the authority-field strip at the wire boundary). Serve-in-attach-mode is the recorded residual.
- `apps/desktop` (increment 3) — attach-or-bind on launch; Tauri organs become bridged capabilities.
