---
"motebit": major
---

The CLI sends a relay's operator (master) token only to the relay URL you bound it to. It used to send it to whatever relay URL a command resolved.

An operator token is one relay's master credential: the relay compares it as an opaque string, and nothing in it says which relay it is for. The CLI read it from `--sync-token`, `MOTEBIT_API_TOKEN` or `MOTEBIT_SYNC_TOKEN` and paired it with the relay URL of the invocation, which arrives by a separate route (`--sync-url`, `MOTEBIT_SYNC_URL`, the saved `sync_url`). With relay A's token exported and the URL naming relay B — a different flag, a changed variable, a `motebit sync enable <url>` — B received A's master token, and B's operator, or anyone who can read B's request logs, could then act as A's operator.

Now a token is sent to a relay only when you have recorded that it belongs to that relay:

```bash
MOTEBIT_API_TOKEN=<that relay's token> motebit relay bind-token --sync-url <url>
```

`motebit relay bind-token` writes `relay-operator-tokens.json` in the config directory (mode 0600): one SHA-256 hash per relay URL, never the token. The URL must be given with `--sync-url` in that command; `MOTEBIT_SYNC_URL`, the saved `sync_url` and `--sync` are refused, because the pairing has to be stated in the command. The token comes from `--sync-token`, then `MOTEBIT_API_TOKEN`, then `MOTEBIT_SYNC_TOKEN`; the command prints which one it used and six characters of the hash. It replaces an existing entry for that relay (a rotated token) and says so, says when the same token is already bound to another relay, and says when the two variables are both set and differ. It makes no network request and does not check the token against the relay.

Every site that sent the token now asks one module (`apps/cli/src/relay-operator-token.ts`) for the token of the relay it is about to contact: the subcommands (`delegate`, `balance`, `withdraw`, `fund`, `discover`, `credentials`, `ledger`, `export`, `migrate`, `federation peers / peer / peer-remove / mesh`, `smoke reconciliation`, `doctor`), the REPL (startup sync and discovery, and the slash commands), and the daemons (`motebit run`, `motebit serve`: event sync, the WebSocket, the task-receipt POST). A token that is set but not bound to that relay is not sent: the command prints one line on stderr naming the source, the relay and the bind command (never the token), and behaves exactly as it does with no operator token set. Each site still reads the same sources, in the same order, as before; none reads a variable it ignored before.

Also in this release:

- `motebit federation mesh <url1> … <urlN>` sends the configured token only to the URLs it is bound to; the others get the device token. `MOTEBIT_MESH_TOKENS` (one token per URL, in order) and `MOTEBIT_PEER_API_TOKEN` are unchanged: each is already a pairing typed in the command.
- `motebit credentials` and `motebit export` with no relay URL no longer resolve any credential (for `credentials`, no passphrase prompt on a local-only run).
- `/connect` still refuses whenever an operator token is set, bound or not.
- `motebit relay up` prints the bind command beside the export hint.
- A relay that redirects: the token is not forwarded to another origin (the platform drops `Authorization` on a cross-origin redirect); a relay that redirects to another path on its own origin carries it there.

Two sites have no behavioural test because nothing reaches them: `motebit run`'s plan-delegation token factory and `motebit serve --self-test`'s token fallback. Both go through the same module and are held by the `check-cli-operator-token-reader` gate alone.

Not covered: the desktop app, which keeps one master-token slot and sends it to whatever relay is configured. The record ties a token to a URL you named; it does not prove the relay is honest or that the URL still reaches the same operator.

## Migration

Everyone who uses a relay operator token with the CLI is affected. After upgrading, the first command prints the withheld line and behaves as if no operator token were set, until the token is bound.

**Before:**

```bash
export MOTEBIT_API_TOKEN=<relay token>
motebit smoke reconciliation --sync-url https://relay.example.com    # sent the token
```

**After:** bind once, then nothing else changes.

```bash
export MOTEBIT_API_TOKEN=<relay token>
motebit relay bind-token --sync-url https://relay.example.com    # once
motebit smoke reconciliation --sync-url https://relay.example.com    # sends the token
```

The bind is **per relay**, **per config directory** (an agent scaffolded with its own `MOTEBIT_CONFIG_DIR` has its own record) and **per URL spelling**: host case, a default port and trailing slashes are unified, but the path is kept, and `http://localhost:3000` and `http://127.0.0.1:3000` are different entries. Bind the spelling you use.

What each group sees until it binds, and its remedy:

**1. Admin commands that need the master token** — `motebit smoke reconciliation`, `motebit federation peer / peer-remove / mesh`, the treasury probe in `motebit doctor`. (`motebit federation peers` reads a route the relay registers without a token check, so it should keep working; it no longer attaches the token to a relay it is not bound to.) `smoke reconciliation` refuses locally ("requires a master token"); the federation commands are refused by the relay (401 or 403, `operator-confirm` for `peer` and `mesh`); `doctor` reports the probe as skipped and says the token is set but not bound. Remedy: `motebit relay bind-token --sync-url <url>`. For `federation mesh` over several relays sharing one token, bind each URL, or pass `MOTEBIT_MESH_TOKENS` for that command.

**2. Commands with a device-token path** — `balance`, `withdraw`, `fund`, `ledger`, `credentials`, `export`, `discover`, `delegate`, `migrate`, REPL sync and the slash commands. They run as this device's identity instead of as the operator. For your own identity the result is usually the same; a query about another identity is refused. Remedy: bind, if you meant to act as the operator.

**3. A passphrase prompt in scripts.** Every subcommand that falls back to the device token unlocks the identity key, which prompts for the passphrase. A scripted operator command that never prompted will now wait on a prompt, or read stdin. The withheld line is printed before the prompt. Remedy: bind the token (no fallback, no prompt), or set `MOTEBIT_PASSPHRASE`.

**4. Relays that turn device auth off** (`MOTEBIT_ENABLE_DEVICE_AUTH=false`). There every device-token fallback is refused, so every command in groups 1 and 2 fails until the token is bound. Remedy: bind.

**5. Daemons holding a token and no device key** — `motebit run` or `motebit serve` whose identity key did not open, or whose config has no `device_id`. Sync, the WebSocket and task receipts stop authenticating. Remedy: bind the token in the daemon's config directory. `motebit run` reads `--sync-token` then `MOTEBIT_SYNC_TOKEN`; `motebit serve` reads `--sync-token` then `MOTEBIT_API_TOKEN`; bind the value the daemon reads. A daemon resolves its token once, when it starts: restart it after binding. (A REPL's slash commands pick a new bind up at the next command; its background sync at the next start.)

**5a. A daemon with a device key, on a relay with device auth off.** `motebit run` or `motebit serve` whose key opened used to send the operator token first for event sync and task receipts. With the token unbound it now signs as the device, which such a relay refuses, so sync and receipts stop authenticating there too. Remedy: bind the token in the daemon's config directory and restart it.

**6. A REPL started with a token and no device key.** It gets no delegation wiring at all (it used to delegate with the operator token). Remedy: bind.

**7. A scaffolded agent or a second config directory.** The record lives in the config directory, so each one binds for itself: `MOTEBIT_CONFIG_DIR=<dir> motebit relay bind-token --sync-url <url>`.

**8. A relay URL that cannot be bound.** A URL that is not `http` or `https`, does not parse, or contains `@`, `?`, `#`, a backslash, whitespace or a control character has no entry and never gets a token. There is no remedy other than naming the relay by a plain URL without those.

**9. A damaged `relay-operator-tokens.json`.** A file that does not parse, has another version or holds a non-string entry means no token is sent to any relay; every command says so once and continues. `bind-token` refuses to overwrite it. Remedy: move the file aside and bind again.

**Why:** a credential must be sent only to the party it was issued for, and an operator token cannot say who that is. The pairing therefore has to be recorded by the owner, once, in a command that shows both halves. The lighter rule — honour a token whenever `--sync-token` and `--sync-url` are flags of the same command — was not taken: two ways to pair doubles what has to be reviewed, and one command per relay is a small cost for a relay operator.
