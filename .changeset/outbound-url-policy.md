---
"@motebit/sdk": minor
"motebit": patch
---

`@motebit/sdk`: outbound URL policy — `checkOutboundUrl`, `assertOutboundUrl`, `fetchPublic`, `isPublicAddress`, `OutboundUrlRefusedError`. The one law for fetching a URL motebit did not author: http(s) only, no credentials, never loopback / private / link-local (cloud metadata) / multicast / reserved / `*.local` / `*.internal`, IPv4-in-IPv6 refused, resolved addresses checked when a resolver is injected, every redirect hop re-checked. Consumed by the web proxy's `/v1/fetch`, the `read_url` tool (and so the read-url and web-search atoms), and the relay's agent-registration, federation-proposal and MCP-forward seams.

`motebit` (CLI): the local `read_url` tool refuses non-public destinations by default; `MOTEBIT_ALLOW_PRIVATE_URLS=1` is the explicit developer allowance for reading a localhost server.
