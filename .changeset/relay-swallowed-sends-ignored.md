---
"@motebit/relay": patch
---

**A frame handed to a closed socket no longer counts as delivered, and a task another door already presented is not re-sent on reconnect** (#811).

`ws@8` throws from `send` only while a socket is CONNECTING. On a CLOSING or CLOSED socket it drops the frame and returns. Every relay send site used a bare `peer.ws.send(payload)`, and task dispatch set `routed = true` afterwards. So a task whose worker had only a closed socket in `connections` was reported routed when nothing had received it. A paid pinned task, or one routed by ranking, was then stranded: it executed zero times.

- **One send rule.** `ws-send.ts` holds `sendIfOpen`, which sends only to an OPEN socket and returns whether the frame was handed over, and `sendToEach`, which fans out and returns how many sockets took the frame. Every peer send in the relay uses one of them: task dispatch (phases 0, 1 and 2), the `task_result` fan-outs, federation forward and result, proposals, data-sync, sync events, the WebSocket fan-outs and the drain notice. `sendToOne` (#691) keeps its selection unchanged and uses `sendIfOpen` for the send.
- **`routed` and `status` report only a real hand-off.** When every socket is CLOSING or CLOSED:
  - pinned paid dispatch and ranked local dispatch forward to the worker's MCP endpoint (main delivered these tasks nowhere);
  - the broadcast is held for reconnect (below);
  - a federated forward answers `pending` (202) instead of `routed`.
- **Recovery stays the presenter where main made it one.** If the broadcast found the agent's sockets but all of them were closed, and nothing else routed the task, the task is held for the agent's reconnect recovery, as on main: no phase 3 MCP forward is taken and no incidental `dispatch_token` goes to the submitter. On main this case read as routed, and recovery delivered the task; it still does. A token would add a second presenter beside recovery, and a phase 3 forward to a flaky endpoint would hold recovery back while it ran. The push wake still fires: it only nudges the device to reconnect.
- **One admission, one presenter, on reconnect recovery** (`task-presentation.ts`). Recovery used to re-send every Pending, receipt-less task to any socket of the task's motebit that connected, without checking whether another door had already presented it. The worker's admission ledger guards only `motebit_task`, never a WebSocket `task_request`, so the same task ran twice. A queue entry is now marked `presented` (persisted in `task_json`) in three cases:
  - when the relay's MCP forward is started;
  - when a federation forward is started;
  - when the submitter chose `presenter: "submitter"`.

  Each mark is set before the door's first await, and recovery skips a marked entry.

  A mark belongs to one relay process. It carries that process's boot id, and any other boot treats it as absent. After a restart the relay no longer holds the forward it marked, so recovery re-sends the task exactly as on main, and a task main would complete is never left pending until its TTL. The mark is written into `task_json` only because the queue is SQLite-backed and recovery in the same process reads the row.

- **A relay forward's mark lives only while the forward is in flight.** When an MCP forward settles, its mark is released whatever the outcome: a forward that stored a receipt leaves nothing for recovery to send, and every other ending goes back to recovery. That covers a refused, reset or timed-out connection at any step, including `tools/call`, a non-2xx answer, and a 2xx answer carrying no receipt, such as an admission refusal or a tool error. A federation forward's mark is released unless the peer accepted: on a refusal, a thrown fetch (refused, reset, timeout) or a failed signature. On release, the sockets that connected while the mark held recovery back receive the task, as recovery would have given it. `forwardTaskViaMcp` now returns `McpForwardOutcome` (`receipt` or `no_receipt`) for its log and tests; the release does not depend on it.

  A mark is never kept on an ambiguous failure. Keeping it there ("`tools/call` was sent, then the connection died") stranded tasks that main executes and settles through recovery. They stayed `pending` with zero executions until their TTL, and a connect refusal was counted the same way. The rule is never worse than main. The accepted residual is shared with main: when the worker DID run the task and only its answer was lost (a reset or timeout after execution, or an unparseable receipt), recovery hands the task over and it runs a second time.

- **Chosen presenter: a relay-side completion main reached by a second execution.** A submitter that chose `presenter: "submitter"` keeps its mark, so recovery no longer sends the task to the worker's socket as well. Main executed such a task twice, once by the submitter and once over the socket, and the socket's receipt completed the relay's queue entry. Here it executes once. The entry completes on the relay only if a receipt is posted to it, and a molecule that presents keeps its atom's receipt in its own `delegation_receipts`.
- **Deliberately not a mark: the incidental token** handed to a submitter because nothing routed and no socket was ever seen. The relay cannot see whether that submitter presents, and the runtime's own delegation client never does: it polls, and its task reaches the worker only through recovery. A submitter that does present that token and a reconnecting device can still both run the task. This predates this change, and closing it needs the worker's WebSocket executor to honour admission.

"Handed over" means the frame is in an OPEN socket's buffer. It is not an acknowledgement: a half-open socket still reads OPEN, because there is no ping/pong reaper.
