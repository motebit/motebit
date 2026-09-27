---
"@motebit/relay": patch
---

**A frame handed to a closed socket no longer counts as delivered, and a task another door already presented is not re-sent on reconnect** (#811).

`ws@8` throws from `send` only while a socket is CONNECTING. On a CLOSING or CLOSED socket it drops the frame and returns. Every relay send site used a bare `peer.ws.send(payload)`, and task dispatch set `routed = true` afterwards. So a task whose worker had only a closed socket in `connections` was reported routed when nothing had received it. A paid pinned task, or one routed by ranking, was then stranded: it executed zero times.

- **One send rule.** `ws-send.ts` holds `sendIfOpen`, which sends only to an OPEN socket and returns whether the frame was handed over, and `sendToEach`, which fans out and returns how many sockets took the frame. Every peer send in the relay uses one of them: task dispatch (phases 0, 1 and 2), the `task_result` fan-outs, federation forward and result, proposals, data-sync, sync events, the WebSocket fan-outs and the drain notice. `sendToOne` (#691) keeps its selection unchanged and uses `sendIfOpen` for the send.
- **`routed` and `status` report only a real hand-off.** When every socket is CLOSING or CLOSED:
  - pinned paid dispatch and ranked local dispatch forward to the worker's MCP endpoint;
  - the broadcast falls through to phase 3 and the push wake;
  - a federated forward answers `pending` (202) instead of `routed`.
- **The relay stays the presenter where main made it one.** If the broadcast found the agent's sockets but all of them were closed, and nothing else routed the task, no incidental `dispatch_token` goes to the submitter. On main this case read as routed, and the agent's reconnect recovery delivered the task; it still does. A token here would add a second presenter beside recovery.
- **One admission, one presenter, on reconnect recovery** (`task-presentation.ts`). Recovery used to re-send every Pending, receipt-less task to any socket of the task's motebit that connected, without checking whether another door had already presented it. The worker's admission ledger guards only `motebit_task`, never a WebSocket `task_request`, so the same task ran twice. A queue entry is now marked `presented` (persisted in `task_json`) in three cases:
  - when the relay's MCP forward is started;
  - when a federation forward is started;
  - when the submitter chose `presenter: "submitter"`.

  Each mark is set before the door's first await, and recovery skips a marked entry.

  A mark belongs to one relay process. It carries that process's boot id, and any other boot treats it as absent. After a restart the relay no longer holds the forward it marked, so recovery re-sends the task exactly as on main, and a task main would complete is never left pending until its TTL. The mark is written into `task_json` only because the queue is SQLite-backed and recovery in the same process reads the row.

- **When a forward never reached the worker, the mark is released.** `forwardTaskViaMcp` now returns `McpForwardOutcome`:
  - **`not_presented`:** the outbound URL was refused, `initialize` was refused or unreachable, or `tools/call` was answered non-2xx.
  - **`presented`:** `tools/call` was answered 2xx, or it was sent and then died unanswered. The worker may be running it.

  A federation forward the peer explicitly refuses also releases its mark. On release, the sockets that connected while the mark held recovery back receive the task, as recovery would have given it.

- **Deliberately not a mark: the incidental token** handed to a submitter because nothing routed and no socket was ever seen. The relay cannot see whether that submitter presents, and the runtime's own delegation client never does: it polls, and its task reaches the worker only through recovery. A submitter that does present that token and a reconnecting device can still both run the task. This predates this change, and closing it needs the worker's WebSocket executor to honour admission.

"Handed over" means the frame is in an OPEN socket's buffer. It is not an acknowledgement: a half-open socket still reads OPEN, because there is no ping/pong reaper.
