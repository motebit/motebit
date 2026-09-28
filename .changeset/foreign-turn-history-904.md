---
"motebit": patch
---

`motebit serve`: a caller's `motebit_query` no longer lands in your conversation (#904). Sibling: `foreign-turn-history-904-ignored.md` (the runtime change).

Before this fix, the caller's text was saved in your chat history as if you had typed it. Your next turn read it as your own words, could form a memory from it marked as something you said, and conversation sync copied it to your other devices. A served `motebit_task` also left the customer's prompt in a stored conversation. Now another principal's turn writes nothing to your conversation: not the live history, not the store, not sync. What that turn did stays on its signed receipt, in the tool audit, and in memories marked as coming from a peer agent.

A caller's `motebit_query` also no longer sees your conversation. Its turn is built without your chat history, conversation summary or session details. It cannot release a "no" you gave to a tool, cannot set aside an approval waiting for you, and does not count as activity from you.
