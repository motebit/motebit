---
"motebit": patch
---

**`MOTEBIT_FAULT_TASK_POLL` lets a test run make the CLI see a lost or flaky delegation result** (#433 acceptance). This is test-only and off unless the variable is set.

#433 was a severe failure: a transient relay 503 then 404 on the result poll made the agent re-hire and pay again, and a "no" at the second payment prompt did not end it. The production relay cannot be faulted on demand, so a founder acceptance run needs the client to see that failure on purpose.

When the variable is set, the CLI wraps `fetch` so that only the delegator's result poll (`GET /agent/:id/task/:taskId`) fails. Submit, payment, the worker's `/result` POST and every other request pass through untouched, so the runtime's real poll loop meets a real HTTP failure. Two values are accepted:

- `503x<N>`: the first N polls of each task get 503, then the relay answers.
- `lost`: every poll gets 404 `TASK_NOT_FOUND`, the #433 shape.

The CLI prints a warning banner on stderr while the fault is on. Any other value refuses to start, so a typo never runs a real hire unfaulted.
