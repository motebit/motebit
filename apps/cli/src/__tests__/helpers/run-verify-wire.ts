/**
 * Process entry for the differential test: runs `motebit verify <kind> <path>
 * [--lenient]` through the real `handleVerifyWire` (same exit-code path as the
 * `motebit` binary) without booting the rest of the CLI.
 */
import { handleVerifyWire } from "../../subcommands/verify-wire.js";

const [kind, path, ...rest] = process.argv.slice(2);
await handleVerifyWire(kind, path, { json: false, lenient: rest.includes("--lenient") });
process.exit(0);
