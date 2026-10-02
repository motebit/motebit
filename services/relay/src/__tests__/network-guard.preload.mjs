/**
 * The network guard for a relay CHILD process — `node --import` this before
 * the entry (the booted-entry harness puts it in the child's NODE_OPTIONS).
 * A booted relay under test reaches no network: every non-loopback dial is
 * refused (scope: the header of `network-guard-core.mjs`), and each refusal is written to stderr as one line starting with
 * `CHILD_REFUSAL_MARKER`, which the harness reads back from the child's log.
 * The guard also imports this file into every worker thread it lets start.
 */
import { isMainThread } from "node:worker_threads";
import {
  CHILD_REFUSAL_MARKER as MARKER,
  WORKER_REFUSAL_CHANNEL,
  installNetworkGuard,
} from "./network-guard-core.mjs";

/**
 * In a worker thread (the guard wraps `Worker` so every thread imports this
 * preload), a refusal is reported to the main thread, whose `refuse` records
 * it — the child's stderr marker, or the vitest setup file's violations.
 */
const toMainThread = isMainThread ? null : new BroadcastChannel(WORKER_REFUSAL_CHANNEL);
toMainThread?.unref();

/** @param {string} target */
function refuse(target) {
  if (toMainThread) toMainThread.postMessage(target);
  else process.stderr.write(`${MARKER} ${target}\n`);
  return new TypeError(`${MARKER} ${target} (refused by network-guard.preload.mjs)`);
}

installNetworkGuard(refuse);
