---
"@motebit/web": minor
---

Free first-taste ignition — a brand-new user gets an instant first answer, no setup.

The companion to the relay's free-credit engine: when a fresh motebit (no provider) sends its **first message**, the web now tries the free "first taste" on motebit cloud before asking the user to set anything up. It fetches a proxy-token from the relay — which grants the one-time free credit if the operator has enabled it — and connects. Thinking dots show during the brief connect; on success the message just sends; only if the free cloud isn't available (disabled / exhausted / offline) does it fall back to the calm "choose a model in Settings" guide.

- `getSyncUrl` falls back to `DEFAULT_RELAY_URL` so a sync-less fresh motebit can reach the relay for a token. Bootstrap is **only called on the first message (intent)** — boot no longer fetches a proxy-token, so a purely-local motebit still never phones home on load (and free credit is never spent on bounces).
- New `tryFreeCloud` chat callback → `autoInitProxy()`; the no-provider send path attempts it before guiding to Settings.
- Once connected, `onProviderReady` saves the `motebit-cloud` config (as today), so later boots reconnect on the remaining credit.

With the relay engine, this completes the activation path: land → meet the creature → type → instant answer on the house → upgrade when the taste runs out. User-visible only when the operator sets a free-credit budget.
