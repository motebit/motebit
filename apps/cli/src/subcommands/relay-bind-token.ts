/**
 * `motebit relay bind-token --sync-url <url>` — the deliberate act that lets
 * the CLI send an operator token to a relay.
 *
 * An operator token is sent only to a relay URL it is bound to
 * (`../relay-operator-token.ts`). This command records the pairing: the URL
 * typed in THIS command, and the token this process was given. The handler
 * never holds the token — reading, hashing and writing happen inside
 * `bindOperatorToken`, and this file is its only importer
 * (`check-cli-operator-token-reader`).
 *
 * The URL must come from the `--sync-url` flag. `MOTEBIT_SYNC_URL`, the saved
 * `sync_url` and `--sync` are refused: a URL arriving by another route than
 * the command line is the defect this record closes, so the shared relay URL
 * resolver is deliberately not used here.
 *
 * It makes no network request and does not check the token against the
 * relay: checking would mean sending the token to a URL before it is bound.
 * The next operator command proves it.
 */
import { sanitizeRelayText } from "@motebit/sync-engine";
import { RELAY_BIND_TOKEN_USAGE, type CliConfig } from "../args.js";
import { bindOperatorToken } from "../relay-operator-token.js";

export function handleRelayBindToken(config: CliConfig): void {
  const url = config.syncUrlFlag;
  if (url == null || url === "") {
    if (config.syncUrl != null) {
      console.error(
        "Error: `motebit relay bind-token` does not accept --sync: the command must show the relay URL the token is bound to. Pass --sync-url <url>.",
      );
    } else {
      console.error(
        "Error: `motebit relay bind-token` needs the relay URL on the command line (--sync-url <url>). " +
          "It does not read MOTEBIT_SYNC_URL or the saved config: the pairing of token and relay must be stated in the command.",
      );
    }
    console.error(RELAY_BIND_TOKEN_USAGE);
    process.exit(1);
  }

  const result = bindOperatorToken(url, config);
  if (!result.ok) {
    // Already built from sanitized parts; sanitized whole as every printed
    // refusal is, with room for a long path and URL.
    console.error(`Error: ${sanitizeRelayText(result.message, 2000)}`);
    process.exit(1);
  }

  const relay = sanitizeRelayText(result.relay);
  console.log(
    result.replaced
      ? `Replaced the operator token bound to ${relay}.`
      : `Bound the operator token to ${relay}.`,
  );
  console.log(
    `  token   from ${result.source} (sha256 ${result.hashPrefix}…; the token is not stored)`,
  );
  console.log(`  record  ${result.file}`);
  for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
  console.log(
    "No request was made: the relay has not checked this token. Your next operator command does.",
  );
}
