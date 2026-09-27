---
"@motebit/relay": patch
---

**A frame handed to a closed socket no longer counts as delivered; every dispatch site names the door it takes, and each is main's** (#811).

`ws@8` throws from `send` only while a socket is CONNECTING. On a CLOSING or CLOSED socket it drops the frame and returns. Every relay send site used a bare `peer.ws.send(payload)`, and task dispatch set `routed = true` afterwards, so a task whose worker had only a closed socket in `connections` was reported routed when nothing had received it.

- **One send rule.** `ws-send.ts` holds `sendIfOpen`, which sends only to an OPEN socket and returns whether the frame was handed over, and `sendToEach`, which fans out and returns how many sockets took the frame. Every peer send in the relay uses one of them: task dispatch (phases 0, 1 and 2), the `task_result` fan-outs, federation forward and result, proposals, data-sync, sync events, the WebSocket fan-outs and the drain notice. `sendToOne` (#691) keeps its selection unchanged and uses `sendIfOpen` for the send.
- **One presenter rule** (`mainWouldRecover` / `routeToSockets` in `task-presentation.ts`), consulted by every site that chooses between a socket, reconnect recovery and a fallback: pinned paid dispatch, ranked local dispatch, the broadcast, and the federation hand-off. When a worker's registered sockets are all CLOSING or CLOSED, main counted the send routed and left the task to reconnect recovery; the relay now names that door (`held_for_recovery`, logged `task.held_for_reconnect`) and takes it — no MCP forward, no push wake, no incidental `dispatch_token`. Only a worker with no socket at all takes the MCP fallback, as on main. A federated forward whose target's sockets are all closed answers `pending` (202) instead of `routed`. Reconnect recovery's own predicate (`recoverableOnReconnect`: Pending, no receipt) is main's, named in the same module.

**What this change deliberately does not do, and why.** Earlier builds of #811 added presenters or held recovery back, and each was withdrawn for a cell where the branch did worse than main:

- forwarding a swallowed send to the worker's MCP endpoint (v1–v3). Recovery serves the URL agent's devices (`task.motebit_id`) whether or not that agent is the worker the site picked, so main always has a presenter for a swallowed send and a forward is a second one: when the forward's worker runs the task and the answer is lost, recovery runs it again — two executions where main had one (#854, and the same when the URL agent is the delegator).
- marking a task presented so recovery skips it while an MCP forward runs, when a submitter chose `presenter: "submitter"`, or when a peer accepted a federation forward (v2–v3). Each mark strands a task main completes: a device held back while the forward ran and gone before it failed, a chosen presenter that never presents, a peer that accepted but never delivered.

Which of those happens is decided after the door is taken, so no rule that adds or withholds a presenter is never worse than main. The accepted residuals are main's own, unchanged: a pinned or ranked task whose worker's sockets are all closed waits for a device of the URL agent to reconnect; a device that reconnects while an MCP forward or a chosen submitter's presentation runs can run the task beside it.

**Proof: `__tests__/presentation-matrix.probe.ts`**, an exhaustive differential matrix over the real served relay — 10 routing modes × 3 socket states × every endpoint or federation-forward outcome × up to 7 reconnect timings, 1398 cells — judged against main by `presentation-matrix.assert.ts` (executions never above main's where main executed; main completed or settled ⇒ so does the branch; main 0 ⇒ at most one). Run it with `scripts/differential-vs-main.ts --probe … --out report.json`, then the assert script on the report.

"Handed over" means the frame is in an OPEN socket's buffer. It is not an acknowledgement: a half-open socket still reads OPEN, because there is no ping/pong reaper.
