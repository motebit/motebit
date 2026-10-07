---
"@motebit/mcp-server": minor
"@motebit/molecule-runner": patch
---

Client half of #875 (relay key proof of possession), shipped before the relay enforces it.

- `@motebit/mcp-server`: `RelayAuth` gains an optional `signRegistration`, and the service signs its bootstrap with it. Without it, the service never sends an unsigned bootstrap: it logs once and registers with its signed bearer.
- `@motebit/molecule-runner`: wires `signRegistration` from the molecule's identity key.
