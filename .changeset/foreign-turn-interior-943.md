---
"motebit": patch
---

`motebit serve`: a caller's `motebit_query` no longer sees your memories or the rest of your private context (#943). Sibling: `foreign-turn-interior-943-ignored.md` (the runtime and loop change).

Before this fix, a caller's question was answered with your memories in the model's context: your pinned memories, the memories most similar to the question (personal tier and below), your memory index and your ten most recent events. The same turn also got the agents you know and trust, your motebit's self-model, reminders of memories that are fading, your installed skills, and live facts about your session such as the page your browser had open. A caller could ask the model to repeat any of it. The same was true of a customer's `motebit_task` and of any approval such a turn waited on.

Now another principal's turn recalls none of your memories and gets none of that context. It still has your motebit's identity and persona, the tools it is allowed to use, and the model it runs on. As a result, a served query can no longer answer from what you have told your motebit. If you want strangers to be answered from some of your motebit's knowledge, that needs an explicit "shareable" setting on the memories you choose. That setting does not exist yet, and it will never be on by default.

Not changed here: the separate `motebit_recall` MCP tool that `motebit serve` exposes still returns your memories (none and personal tier) to a caller directly. It is tracked as its own fix.
