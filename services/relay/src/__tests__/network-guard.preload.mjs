/**
 * The network guard for a relay CHILD process — `node --import` this before
 * the entry (the booted-entry harness puts it in the child's NODE_OPTIONS).
 * A booted relay under test reaches no network: every non-loopback dial is
 * refused, and each refusal is written to stderr as one line starting with
 * `CHILD_REFUSAL_MARKER`, which the harness reads back from the child's log.
 */
import {
  CHILD_REFUSAL_MARKER as MARKER,
  installFetchGuard,
  installSocketGuard,
} from "./network-guard-core.mjs";

/** @param {string} target */
function refuse(target) {
  process.stderr.write(`${MARKER} ${target}\n`);
  return new TypeError(`${MARKER} ${target} (refused by network-guard.preload.mjs)`);
}

installFetchGuard(refuse);
installSocketGuard(refuse);
