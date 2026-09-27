---
"@motebit/relay": patch
---

**A frame handed to a closed socket no longer counts as delivered** (#811).

`ws@8` throws from `send` only while a socket is CONNECTING. On a CLOSING or CLOSED socket it drops the frame and returns. Every relay send site used a bare `peer.ws.send(payload)`, and task dispatch set `routed = true` afterwards. So a task whose worker had only a closed socket in `connections` was reported routed when nothing had received it. That skipped the MCP endpoint forward and the push wake, and the submitter got no dispatch token.

- **One send rule.** `ws-send.ts` holds `sendIfOpen`, which sends only to an OPEN socket and returns whether the frame was handed over, and `sendToEach`, which fans out and returns how many sockets took the frame. Every peer send in the relay uses one of them: task dispatch (phases 0, 1 and 2), the `task_result` fan-outs, federation forward and result, proposals, data-sync, sync events, the WebSocket fan-outs and the drain notice. `sendToOne` (#691) keeps its selection unchanged and uses `sendIfOpen` for the send.
- **`routed` and `status` report only a real hand-off.** If every socket is CLOSING or CLOSED, the caller takes exactly the path it takes when no socket is connected:
  - pinned paid dispatch and ranked local dispatch forward to the worker's MCP endpoint;
  - the broadcast falls through to phases 3 and 4, and the submitter gets its dispatch token;
  - a federated forward answers `pending` (202) instead of `routed`.

  The task stays queued and reaches the agent when it reconnects, as before.

- **Unchanged:** when at least one OPEN socket is connected. Fan-outs already reached it, and they reach the same OPEN sockets now. A differential run against main (`__tests__/swallowed-sends.probe.ts`) shows 21 observations: 16 are the same, and the 5 that differ are the closed-only rows of the sites that report delivery.

"Handed over" means the frame is in an OPEN socket's buffer. It is not an acknowledgement: a half-open socket still reads OPEN, because there is no ping/pong reaper.
