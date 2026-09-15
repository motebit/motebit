---
"create-motebit": patch
---

The scaffolded agent no longer carries a relay API token. `.env.example` drops `MOTEBIT_API_TOKEN`, and the generated README's "Authentication for the relay" section now describes what the runtime actually does: the agent introduces its key through the relay's public bootstrap endpoint on first boot, mints a short-lived Ed25519-signed token per call bound to the audience each route expects, and verifies the relay-signed `task:dispatch` admission token on paid tasks. The operator's master token never leaves the relay, so a worker has nothing to hold. Next-step hints and the project-tree summary are updated to match.
