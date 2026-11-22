---
"@motebit/runtime": major
"@motebit/persistence": minor
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
"@motebit/spatial": patch
"@motebit/molecule-runner": patch
---

The runtime holds ONE delegation relay binding (design runtime-relay-binding rev 6, part 4a).

The relay a runtime delegates to used to live in five places that rebound differently (the delegation tools' closures and credential submitter, the task-query coordinates, the granted-spend coordinates, the tap manager, and a hardware-attestation capabilities fetcher built over a surface's bootstrap URL), so after a relay switch or a Disconnect some calls still reached the previous relay. Now:

- `@motebit/runtime`: `bindRelay(binding)` / `unbindRelay()` replace `enableInteractiveDelegation`, `disableInteractiveDelegation` and `enableInvokeCapability`. Every delegation call (a relay tool execution, a tap, a granted spend, a result retrieval, a credential submission) reads one snapshot of the binding when it starts and sends every tokened request to that snapshot's relay; a call already running finishes on its snapshot. A tool call approved under one binding generation is refused `relay_changed` under another, and nothing is sent. `getDelegationRelay()` returns `{ url, pinned }` or null. `PaidIntentLedger` writers take the relay as a required argument; `UnretrievedPayment.relayUrl`; `TaskRetrieval` gains `bound_elsewhere`. `createRelayCapabilitiesFetcher` loses `baseUrl` and the fetcher takes the relay per call (`HardwareAttestationFetcher(remoteMotebitId, relayUrl)`). `InvokeCapabilityManager` takes a binding accessor instead of a config; `InvokeCapabilityConfig` is removed. `setDelegationAdapter` and `createSovereignDelegationAdapter` are unchanged (plan-step delegation is part 4b).
- `@motebit/persistence`: `paid_intent_ledger.relay_url` (nullable, migration #53).
- `@motebit/web`, `@motebit/desktop`: Connect binds and Disconnect unbinds; a Connect whose relay-key fetch is overtaken by a Disconnect or another Connect binds nothing (a session number). Web also drops the old binding at once when Connect names a different relay (pairing calls Connect without Disconnect).
- `@motebit/mobile`: binds once per sync attempt (the first cycle whose key fetch returns) and unbinds when the attempt is disposed.
- `@motebit/spatial`, `@motebit/desktop`, `@motebit/mobile`: the capabilities fetcher no longer holds a relay URL. Spatial binds no delegation relay, so it no longer makes the hardware-attestation capabilities read after a receipt. That read only adds hardware-attestation scoring to a worker's trust record — it gates nothing — and part 4b (plan-step delegation under the binding) restores it.
- `@motebit/molecule-runner`: binds its relay with the same values it enabled.

## Migration

**Before:**

```ts
runtime.enableInteractiveDelegation({ syncUrl, authToken, relayPublicKey });
runtime.enableInvokeCapability({ syncUrl, authToken, relayPublicKey });
// …on Disconnect
runtime.disableInteractiveDelegation();
runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher({ baseUrl: syncUrl }));
```

**After:**

```ts
runtime.bindRelay({
  syncUrl,
  authToken,
  relayPublicKey,
  tools: true, // delegate_to_agent / discover_agents / retrieve_task_result + credential submission
  invokeCapability: true, // taps
});
// …on Disconnect
runtime.unbindRelay();
runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher());
```

A payment builder is no longer passed with the relay: the runtime binds it from its configured `solanaWallet`. Why: one binding, read once per call, is the only shape in which a switch or Disconnect cannot leave a call on the old relay.
