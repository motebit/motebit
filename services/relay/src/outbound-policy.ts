/**
 * The relay's outbound URL policy — how `@motebit/sdk`'s outbound URL law is
 * parameterised for this process. Every persisted callback the relay will
 * later contact (a registered agent's `endpoint_url`, a federation peer's
 * `endpoint_url`) and every forward to one passes through this.
 *
 * Node has a resolver, so a public NAME that resolves to a private address
 * is refused too. `allowPrivateNetwork` is the local-development switch
 * (`MOTEBIT_ALLOW_PRIVATE_ENDPOINTS=1`, and `createTestRelay`): a relay on a
 * laptop talks to workers on 127.0.0.1. It must never be set on a deployed
 * relay — on Fly, `*.internal` is exactly the surface the law exists to
 * keep registered strangers away from.
 */
import { promises as dns } from "node:dns";
import type { OutboundUrlOptions } from "@motebit/sdk";

export function buildOutboundPolicy(allowPrivateEndpoints: boolean): OutboundUrlOptions {
  return {
    allowPrivateNetwork: allowPrivateEndpoints,
    resolve: async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address),
  };
}
