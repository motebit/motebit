#!/usr/bin/env node
/**
 * `motebit-verify` CLI — offline third-party verifier for every signed
 * Motebit artifact.
 *
 * ```
 *   motebit-verify <file>                # auto-detect, print human
 *   motebit-verify <file> --json         # structured output
 *   motebit-verify <file> --expect receipt    # pin expected type
 *   motebit-verify <file> --clock-skew 30      # seconds
 *   motebit-verify --help
 *   motebit-verify --version
 * ```
 *
 * Exit codes:
 *   0  artifact verified
 *   1  artifact detected but signature / shape invalid
 *   2  usage / I/O error (file missing, bad flag, unreadable)
 *
 * Network-free by design. Everything we need for verification is in
 * the artifact itself + the signer's embedded or derived public key.
 */

import { isCliError, parseArgs, runCli } from "./cli-core.js";

runCli(parseArgs(process.argv.slice(2)))
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`motebit-verify: ${msg}\n`);
    process.exit(isCliError(err) ? err.code : 2);
  });
