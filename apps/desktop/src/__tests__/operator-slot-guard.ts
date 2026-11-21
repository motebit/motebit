/**
 * The shared key-store stand-in for "desktop never reads or sends the relay
 * operator token" (design 2026-11-20, test 0).
 *
 * The slot `sync_master_token` was read by `loadDesktopConfig` and the token
 * sent to whatever relay URL was current. It is removed, but a user who
 * placed a token there by hand still HAS one: the stored value is left in
 * place, unread (decision D1). So every test of the removal runs with the
 * slot FULL, and this guard:
 *
 *   - answers a `keyring_get` of the slot with the token (so a read that
 *     comes back is observable as a send, too), and
 *   - records every such read, with the stack that asked, whatever code path
 *     asks and whatever key-building got it there (a key assembled at run
 *     time is still the same key by the time it reaches `invoke`), and
 *   - fails the test at its end if any read happened (`onTestFinished`), so a
 *     test that forgets to assert still goes red.
 *
 * `carriesOperatorToken` is the wire check: any header value or frame that
 * contains the token.
 */
import { expect, onTestFinished } from "vitest";

/** The key-store slot desktop no longer reads. */
export const OPERATOR_SLOT = "sync_master_token";
/** What the slot holds in every test: a token that must never leave. */
export const OPERATOR_TOKEN = "zz-operator-token-never-sent";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface OperatorSlotGuard {
  /** One stack per read of the slot. Must stay empty. */
  readonly reads: string[];
  /** Wrap a Tauri `invoke`: the slot is full and every read of it is recorded. */
  wrap<T extends Invoke>(inner: T): T;
  /** The assertion, for tests that want it at a chosen point. */
  expectUnread(): void;
}

export function guardOperatorSlot(opts: { failAtEnd?: boolean } = {}): OperatorSlotGuard {
  const reads: string[] = [];
  const guard: OperatorSlotGuard = {
    reads,
    wrap<T extends Invoke>(inner: T): T {
      const wrapped = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (cmd === "keyring_get" && args?.key === OPERATOR_SLOT) {
          reads.push(new Error("keyring_get of the operator slot").stack ?? "(no stack)");
          return OPERATOR_TOKEN;
        }
        return inner(cmd, args);
      };
      return wrapped as unknown as T;
    },
    expectUnread(): void {
      expect(reads, `the operator slot was read:\n${reads.join("\n---\n")}`).toEqual([]);
    },
  };
  if (opts.failAtEnd !== false) onTestFinished(() => guard.expectUnread());
  return guard;
}

/** True when a header value, URL or socket frame carries the operator token. */
export function carriesOperatorToken(text: string | null | undefined): boolean {
  return text != null && text.includes(OPERATOR_TOKEN);
}
