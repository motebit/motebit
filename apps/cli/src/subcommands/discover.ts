/**
 * `motebit discover <motebitId>` — resolve an agent's location across
 * the federation. Uses the relay's discovery endpoint (discovery-v1.md §5).
 *
 * Without arguments, fetches the relay's metadata from /.well-known/motebit.json.
 */

import type { CliConfig } from "../args.js";
import { fetchRelayJson, getRelayUrl, getRelayAuthHeaders } from "./_helpers.js";

export async function handleDiscover(config: CliConfig): Promise<void> {
  const motebitId = config.positionals[1];
  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config);

  // No argument: show relay metadata
  if (!motebitId) {
    const result = await fetchRelayJson(`${relayUrl}/.well-known/motebit.json`, headers);
    if (!result.ok) {
      console.error(`Failed to fetch relay metadata: ${result.error}`);
      process.exit(1);
    }

    const data = result.data as {
      relay_id: string;
      display_name?: string;
      public_key: string;
      endpoint_url: string;
      protocol_version: string;
      capabilities?: string[];
      fee_rate?: number;
      agent_count?: number;
      federation_peers?: Array<{ relay_id: string; endpoint_url: string }>;
    };

    if (config.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`\nRelay: ${data.display_name ?? data.relay_id}`);
    console.log(`  ID:       ${data.relay_id}`);
    console.log(`  URL:      ${data.endpoint_url}`);
    console.log(`  Version:  ${data.protocol_version}`);
    console.log(`  Key:      ${data.public_key.slice(0, 16)}...`);
    if (data.capabilities) console.log(`  Caps:     ${data.capabilities.join(", ")}`);
    if (data.fee_rate != null) console.log(`  Fee:      ${(data.fee_rate * 100).toFixed(1)}%`);
    if (data.agent_count != null) console.log(`  Agents:   ${data.agent_count}`);
    if (data.federation_peers && data.federation_peers.length > 0) {
      console.log(`  Peers:    ${data.federation_peers.length}`);
      for (const peer of data.federation_peers) {
        console.log(`    - ${peer.relay_id.slice(0, 12)}... @ ${peer.endpoint_url}`);
      }
    }
    console.log();
    return;
  }

  // With argument: resolve a specific agent
  const result = await fetchRelayJson(
    `${relayUrl}/api/v1/discover/${encodeURIComponent(motebitId)}`,
    headers,
  );
  if (!result.ok) {
    console.error(`Failed to resolve agent: ${result.error}`);
    process.exit(1);
  }

  const data = result.data as {
    motebit_id: string;
    found: boolean;
    relay_id?: string;
    relay_url?: string;
    capabilities?: string[];
    public_key?: string;
    resolved_via: string[];
    cached: boolean;
    ttl: number;
  };

  if (config.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!data.found) {
    console.log(`\nAgent ${motebitId}: not found`);
    console.log(`  Searched: ${data.resolved_via.join(" → ")}`);
    console.log(`  TTL:      ${data.ttl}s (negative cache)`);
    console.log();
    process.exit(1);
  }

  console.log(`\nAgent ${data.motebit_id}: found`);
  console.log(`  Relay:    ${data.relay_id}`);
  if (data.relay_url) console.log(`  URL:      ${data.relay_url}`);
  if (data.public_key) console.log(`  Key:      ${data.public_key.slice(0, 16)}...`);
  if (data.capabilities?.length) console.log(`  Caps:     ${data.capabilities.join(", ")}`);
  console.log(`  Path:     ${data.resolved_via.join(" → ")}`);
  console.log(`  Cached:   ${data.cached}`);
  console.log(`  TTL:      ${data.ttl}s`);
  console.log();
}
