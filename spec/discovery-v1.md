# motebit/discovery@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-04-11

---

## 1. Purpose

Discovery answers three questions:

1. **Find a relay.** Given a domain name, resolve the relay endpoint that serves it.
2. **Find an agent.** Given a `MotebitId`, determine which relay hosts it and how to reach it.
3. **Relay metadata.** Given a relay URL, learn what it offers — capabilities, fee rate, federation peers, protocol version — in a signed, self-verifiable document.

These three operations underpin every cross-boundary interaction. Federation routing (relay-federation@1.0) assumes relays can find each other. Task delegation (market@1.0) assumes agents can be located. Bootstrap assumes new agents can find their first relay. This spec defines the discovery layer that makes those assumptions concrete.

---

## 2. Design Principles

- **Progressive.** Discovery starts simple and scales with deployment. A direct URL always works. DNS adds domain-level routing. Federation adds network-wide agent resolution. No layer requires the layer above it.
- **Cacheable.** Every discovery result carries a TTL. Clients MUST respect TTLs. Negative results are cacheable (shorter TTL) to prevent repeated lookups for nonexistent agents.
- **Self-verifiable.** Relay metadata is signed by the relay's Ed25519 key. A client that fetches metadata from any source — DNS, federation peer, local cache — can verify authenticity without trusting the transport. No CA, no registry, no external authority.

---

## 3. Relay Well-Known Endpoint

Every relay MUST serve a signed metadata document at a fixed path.

### 3.1 — Endpoint

```
GET /.well-known/motebit.json
```

The endpoint MUST be unauthenticated. No bearer token, no signed token, no API key. Discovery is the bootstrap layer — it cannot require credentials that themselves depend on discovery.

### 3.2 — RelayMetadata

```json
{
  "protocol_version": "1.0",
  "relay_id": "019530a1-7b2c-7000-8000-000000000001",
  "display_name": "us-east-1",
  "public_key": "a1b2c3d4...64 hex chars",
  "endpoint_url": "https://relay.example.com",
  "capabilities": ["task_routing", "federation", "settlement", "credential_store"],
  "fee_rate": 0.05,
  "federation_peers": [{ "relay_id": "019530a1-...", "endpoint_url": "https://peer.example.com" }],
  "agent_count": 1842,
  "signature": "a1b2c3...128 hex chars"
}
```

| Field              | Type     | Required | Description                                                            |
| ------------------ | -------- | -------- | ---------------------------------------------------------------------- |
| `protocol_version` | string   | yes      | Spec version this relay implements (e.g., `"1.0"`)                     |
| `relay_id`         | string   | yes      | Relay's `motebit_id` (UUID v7)                                         |
| `display_name`     | string   | no       | Human-readable relay name                                              |
| `public_key`       | string   | yes      | Hex-encoded Ed25519 public key (64 hex characters)                     |
| `endpoint_url`     | string   | yes      | Canonical HTTPS base URL of this relay                                 |
| `capabilities`     | string[] | no       | Supported features. Known values: see §3.4                             |
| `fee_rate`         | number   | no       | Platform fee as a decimal (0.05 = 5%). Absent means no published rate  |
| `federation_peers` | object[] | no       | Known peers, each with `relay_id` and `endpoint_url`                   |
| `agent_count`      | number   | no       | Approximate number of registered agents. Informational, not guaranteed |
| `signature`        | string   | yes      | Ed25519 signature over all other fields (§3.3)                         |

### 3.3 — Signature Verification

```
ALGORITHM: VerifyRelayMetadata(metadata)

INPUT:  metadata: RelayMetadata object (parsed JSON)

Step 1:  Extract signature field, remove it from the object
Step 2:  Compute canonicalJson(remaining fields) per RFC 8785 (JCS)
Step 3:  Encode canonical JSON string as UTF-8 bytes
Step 4:  Decode signature from hex → 64 bytes
Step 5:  Decode public_key from hex → 32 bytes
Step 6:  Ed25519.verify(signature, canonical_bytes, public_key)
Step 7:  If false → reject
Step 8:  Accept
```

The signature covers `canonicalJson(fields_except_signature)` as raw bytes, consistent with the signing pattern used across all motebit specs (receipts, credentials, batch payloads, succession records).

### 3.4 — Capability Values

Known capability strings. Implementations MAY define additional values using a namespaced format (e.g., `custom:my-capability`).

| Capability         | Description                                    |
| ------------------ | ---------------------------------------------- |
| `task_routing`     | Accepts and routes delegated tasks             |
| `federation`       | Peers with other relays (relay-federation@1.0) |
| `settlement`       | Processes budget allocation and settlement     |
| `credential_store` | Stores and indexes verifiable credentials      |
| `sync`             | Multi-device data synchronization              |

### 3.5 — Foundation Law

1. The path MUST be `/.well-known/motebit.json`. No alternatives.
2. The response MUST include `relay_id`, `public_key`, `endpoint_url`, `protocol_version`, and `signature`.
3. The endpoint MUST be unauthenticated.
4. The signature MUST be verifiable using only the `public_key` in the response and the algorithm in §3.3.

### 3.6 — Convention

Relays SHOULD serve the response with `Cache-Control: public, max-age=3600` (1 hour). Clients SHOULD cache the response and revalidate after the `max-age` expires.

---

## 4. DNS-Based Relay Discovery

Organizations can advertise their relay via DNS, enabling domain-level discovery without hardcoded URLs.

### 4.1 — SRV Record

Per RFC 2782:

```
_motebit._tcp.example.com. 300 IN SRV 10 0 443 relay.example.com.
```

| Field    | Description                                             |
| -------- | ------------------------------------------------------- |
| Service  | `_motebit`                                              |
| Protocol | `_tcp`                                                  |
| Priority | Lower values preferred (standard SRV semantics)         |
| Weight   | Tie-breaking among same-priority records (standard SRV) |
| Port     | TCP port (443 for HTTPS)                                |
| Target   | Hostname of the relay                                   |

### 4.2 — TXT Fallback

For environments where SRV records are unavailable:

```
_motebit._tcp.example.com. 300 IN TXT "url=https://relay.example.com"
```

The TXT record contains a single key-value pair. The `url` value is the relay's canonical HTTPS endpoint.

### 4.3 — Resolution Algorithm

```
ALGORITHM: DiscoverRelayByDomain(domain)

Step 1:  SRV lookup: _motebit._tcp.{domain}
Step 2:  If SRV records found:
           Sort by priority (ascending), then weight (descending)
           For each record:
             Construct URL: https://{target}:{port}
             Fetch /.well-known/motebit.json
             VerifyRelayMetadata(response)
             If valid → return RelayMetadata
Step 3:  If no SRV or all failed, TXT lookup: _motebit._tcp.{domain}
Step 4:  If TXT found, parse "url=..." value:
           Fetch /.well-known/motebit.json at that URL
           VerifyRelayMetadata(response)
           If valid → return RelayMetadata
Step 5:  Return null (no relay found for domain)
```

### 4.4 — Foundation Law

1. The service name MUST be `_motebit`. The protocol MUST be `_tcp`.
2. DNS discovery is additive. A direct URL MUST always work — DNS is never the only path.
3. Post-resolution signature verification (§3.3) is REQUIRED. DNS alone is not sufficient proof of relay authenticity.

### 4.5 — Convention

DNS TTL SHOULD be 300 seconds. Clients SHOULD cache DNS results and revalidate after TTL expiry.

---

## 5. Agent Resolution

Given a `MotebitId`, find which relay hosts the agent and how to reach it.

### 5.1 — AgentResolutionResult

```json
{
  "motebit_id": "019530a1-7b2c-7000-8000-000000000042",
  "found": true,
  "relay_id": "019530a1-7b2c-7000-8000-000000000001",
  "relay_url": "https://relay.example.com",
  "capabilities": ["web_search", "code_review"],
  "public_key": "a1b2c3d4...64 hex chars",
  "settlement_address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
  "settlement_modes": "relay,p2p",
  "resolved_via": ["019530a1-...local", "019530a1-...peer1"],
  "cached": false,
  "ttl": 300
}
```

| Field                | Type     | Required | Description                                                                                         |
| -------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------- |
| `motebit_id`         | string   | yes      | The queried agent's `MotebitId`                                                                     |
| `found`              | boolean  | yes      | Whether the agent was located                                                                       |
| `relay_id`           | string   | if found | The hosting relay's `motebit_id`                                                                    |
| `relay_url`          | string   | if found | HTTPS endpoint of the hosting relay                                                                 |
| `capabilities`       | string[] | no       | Agent's advertised capabilities                                                                     |
| `public_key`         | string   | if found | Agent's hex-encoded Ed25519 public key                                                              |
| `settlement_address` | string   | no       | Agent's declared settlement address (e.g., Solana base58). Explicit, not inferred from `public_key` |
| `settlement_modes`   | string   | no       | Comma-separated settlement modes the agent accepts: `"relay"`, `"relay,p2p"`. Default: `"relay"`    |
| `resolved_via`       | string[] | yes      | Chain of `relay_id`s traversed during resolution (audit trail)                                      |
| `cached`             | boolean  | yes      | Whether the result came from cache                                                                  |
| `ttl`                | number   | yes      | Seconds until this result should be re-resolved                                                     |

### 5.2 — Resolution Algorithm

```
ALGORITHM: ResolveAgent(motebitId, hops, visitedRelays)

INPUT:  motebitId:     MotebitId to resolve
        hops:          remaining hop count (default: 3)
        visitedRelays: set of relay_ids already queried (loop prevention)

Step 1:  Check local agent registry
         If found and agent.federation_visible !== false → return local result

Step 2:  Check resolution cache
         If cached and ttl not expired → return cached result

Step 3:  If hops <= 0 → return { found: false }

Step 4:  Add own relay_id to visitedRelays

Step 5:  For each federation peer (relay-federation@1.0 §4):
           If peer.relay_id in visitedRelays → skip (loop prevention)
           Query peer: GET /api/v1/discover/{motebitId}
             with headers: X-Hop-Limit: {hops - 1}
                           X-Visited-Relays: {comma-separated relay_ids}
           If peer returns found result:
             Cache result (positive TTL: 300s)
             Prepend own relay_id to resolved_via
             Return result

Step 6:  Cache negative result (negative TTL: 60s)
         Return { found: false, resolved_via: [own_relay_id], cached: false, ttl: 60 }
```

### 5.3 — Foundation Law

1. Agent resolution MUST propagate through federation peers when the agent is not hosted locally.
2. The `visited_relays` set MUST be forwarded to prevent resolution loops.
3. Agents with `federation_visible: false` MUST NOT appear in resolution results for remote queries. An agent's hosting relay MUST respect this opt-out.
4. The `resolved_via` chain MUST be included for auditability.

### 5.4 — Convention

Default hop limit is 3. Positive cache TTL is 300 seconds. Negative cache TTL is 60 seconds. These values balance freshness against query amplification.

---

## 6. Bootstrap Discovery

A new agent with no configured relay must find one to register with.

### 6.1 — Bootstrap Flow

```
ALGORITHM: BootstrapAgent()

Step 1:  Read MOTEBIT_SYNC_URL environment variable
         Default: https://relay.motebit.com

Step 2:  Fetch /.well-known/motebit.json from the bootstrap URL

Step 3:  VerifyRelayMetadata(response)
         If invalid → abort (fail-closed)

Step 4:  Register with the verified relay

Step 5:  Persist relay URL to local config for subsequent connections
```

### 6.2 — Foundation Law

1. Bootstrap is OPTIONAL. An agent configured with a direct relay URL MUST NOT require bootstrap.
2. The `MOTEBIT_SYNC_URL` environment variable (or equivalent platform mechanism) overrides the default bootstrap endpoint.
3. The bootstrap relay is verified using the same signature check as any other relay (§3.3). No special trust.

### 6.3 — Convention

The reference implementation defaults to `https://relay.motebit.com`, operated by Motebit, Inc. This is a **product default**, not a protocol requirement. Alternative bootstrap endpoints are first-class. The protocol does not privilege any operator — any relay that serves valid signed metadata at `/.well-known/motebit.json` is an equally valid bootstrap target.

---

## 7. Security Considerations

### 7.1 — Relay Metadata Integrity

The Ed25519 signature on `RelayMetadata` prevents MITM attacks against the well-known endpoint. An attacker who intercepts the response cannot forge the signature without the relay's private key. Clients MUST verify the signature before trusting any field in the metadata.

### 7.2 — DNS Poisoning

DNS is untrusted transport. An attacker who poisons DNS can redirect clients to a malicious relay. The mitigation is post-resolution signature verification: the client fetches the well-known endpoint at the DNS-resolved address and verifies the relay's Ed25519 signature. A poisoned DNS record pointing to a different relay will produce valid metadata — but for the wrong relay identity. Clients that pin a specific `relay_id` will detect the mismatch.

### 7.3 — Federation Query Amplification

Agent resolution propagates through federation peers. Without bounds, a single query could fan out exponentially. The hop limit (default 3) and `visited_relays` loop prevention cap the total number of relays queried per resolution to a bounded set. Relays SHOULD rate-limit inbound resolution queries per-peer (see relay-federation@1.0 §7 rate limiting).

### 7.4 — Privacy

Agent resolution reveals which relay hosts an agent. For agents that require location privacy, the `federation_visible` opt-out (§5.3) prevents resolution responses from disclosing hosting information to remote relays. The opt-out applies to federation queries only — the hosting relay still knows the agent exists.

### 7.5 — Metadata Staleness

Cached relay metadata may become stale if the relay rotates its keypair or changes its endpoint. Clients MUST re-fetch and re-verify metadata after the cache TTL expires. A relay that has rotated keys will produce metadata with a new `public_key` and `signature` — clients that pin the old public key will detect the rotation and must update their records.

---

## 8. Relationship to Other Specs

| Spec                         | Relationship                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| motebit/relay-federation@1.0 | Federation provides the peer-to-peer transport for agent resolution (§5). Discovery provides the bootstrap. |
| motebit/identity@1.0         | Agent and relay public keys follow the identity spec's Ed25519 format and `did:key` derivation.             |
| motebit/market@1.0           | Market routing uses discovery to locate candidate agents. Routing scores are orthogonal to resolution.      |
| motebit/credential@1.0       | Agent capabilities advertised during discovery may reference credential-backed attestations.                |
| motebit/settlement@1.0       | `fee_rate` in relay metadata informs settlement cost estimation before delegation.                          |
| motebit/auth-token@1.0       | Discovery endpoints are unauthenticated. All subsequent interaction requires signed bearer tokens.          |

---

## 9. Conformance

An implementation conforms to this specification if:

1. The relay serves `/.well-known/motebit.json` with the required fields and valid Ed25519 signature (§3.5).
2. DNS discovery uses the `_motebit._tcp` service name and verifies relay metadata post-resolution (§4.4).
3. Agent resolution propagates through federation, includes `visited_relays` for loop prevention, and respects `federation_visible` opt-out (§5.3).
4. Bootstrap is optional — direct URL configuration always works (§6.2).
5. All relay metadata signatures are verified before the metadata is trusted (§7.1).

---

_motebit/discovery@1.0 — Draft Specification, 2026._
