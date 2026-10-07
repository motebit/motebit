---
"motebit": patch
---

**`motebit relay up` no longer runs with its operator routes open.** It used to start the relay with no master token, so the admin, export and sync routes on the port it bound answered anyone. It now uses `MOTEBIT_API_TOKEN` when set; otherwise it generates a token on first boot and keeps it owner-only beside the database (`~/.motebit/relay/relay.db.api-token`), and the boot banner says where. `MOTEBIT_RELAY_INSECURE_NO_AUTH=1` restores the open behaviour for local development only with `NODE_ENV=development` (or `test`); under any other `NODE_ENV`, unset included, `relay up` refuses to start — the same decision the relay's own server makes.
