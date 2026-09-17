---
"@motebit/relay": patch
---

A forwarded command is delivered only to a socket that is actually open.

`ws@8` throws from `send` only while CONNECTING; on CLOSING or CLOSED it swallows the frame and returns, with no callback to surface an error. The command-forward path guarded with `try/catch` alone, so a stale-but-unreaped connection counted as a delivery, `some` short-circuited, and the live process beside it on the same machine was never tried — the caller learning nothing until a thirty-second timeout answered "the agent did not respond", about a runtime that was connected and willing throughout. The ordinary case moments after a process restarts, on the verb it is least acceptable to lose.

Every other send site in the relay already asked `readyState === 1`. This one does now; the `try/catch` stays for the CONNECTING case, which does throw.

Found by the multi-runtime harness modelling the transport wrongly, and a review catching that the model was wrong.
