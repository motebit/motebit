/**
 * The one way the relay hands a frame to a peer socket (#811).
 *
 * A socket in `connections` is not necessarily a socket that can take a
 * frame. `ws@8` only THROWS from `send` while CONNECTING; on CLOSING or
 * CLOSED it calls `sendAfterClose` and returns silently, so a bare
 * `peer.ws.send(payload)` on a stale entry swallows the frame and the caller
 * cannot tell. Task dispatch then set `routed = true` for a task that no
 * socket received, which skipped every fallback (the MCP endpoint forward,
 * the push wake): a pinned or ranked task was stranded with no execution.
 *
 * So every peer send asks `readyState` first and reports whether the frame
 * was actually handed to an OPEN socket. Callers derive `routed` / status
 * from that report and nothing else.
 *
 * Two shapes, never a third:
 *  - `sendIfOpen` — one socket; true iff the frame was handed off. The
 *    one-of rule (`sendToOne` in `command-route.ts`) uses it for every send
 *    and keeps its own selection unchanged.
 *  - `sendToEach` — a fan-out; the number of sockets the frame was handed
 *    to. It delivers to exactly the OPEN sockets a bare loop delivered to,
 *    in the same order, and skips only the ones that would have swallowed
 *    the frame — so no socket that received a frame before this receives
 *    less now.
 *
 * "Handed off" means the frame entered an OPEN socket's send buffer. It is
 * not an acknowledgement: a half-open socket still reads OPEN (there is no
 * ping/pong reaper), and nothing here can see that. What this closes is the
 * case the relay CAN see.
 */

import type { ConnectedDevice } from "./websocket.js";

/**
 * `WebSocket.OPEN` — the only state in which `send` puts a frame on the wire,
 * and the only state in which a socket is registered or counted.
 */
export const WS_OPEN = 1;

/** The part of a socket this module touches (hono's `WSContext` satisfies it). */
export interface SendableSocket {
  readonly readyState: number;
  send(data: string): void;
}

/**
 * Hand `payload` to `ws` if and only if it is OPEN. Returns true when the
 * frame was handed off; false when the socket was not OPEN (the frame would
 * have been swallowed) or when `send` threw (CONNECTING throws).
 */
export function sendIfOpen(ws: SendableSocket, payload: string): boolean {
  if (ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fan `payload` out to every peer that `include` admits (default: all), in
 * order, handing it only to OPEN sockets. Returns how many sockets the frame
 * was handed to — zero means nothing received it, and a caller that reports
 * delivery must take its no-peer path.
 */
export function sendToEach(
  peers: Iterable<ConnectedDevice> | undefined,
  payload: string,
  include?: (peer: ConnectedDevice) => boolean,
): number {
  if (peers == null) return 0;
  let delivered = 0;
  for (const peer of peers) {
    if (include != null && !include(peer)) continue;
    if (sendIfOpen(peer.ws, payload)) delivered++;
  }
  return delivered;
}
