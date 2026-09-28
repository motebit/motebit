---
"motebit": patch
---

`motebit serve`: a caller's `motebit_query` no longer sees your memories or the rest of your private context, and `motebit_recall` no longer returns your memories to other agents (#943). Sibling: `foreign-turn-interior-943-ignored.md` (the runtime and loop change).

Before this fix, a caller's question was answered with your memories in the model's context: your pinned memories, the memories most similar to the question (personal tier and below), your memory index and your ten most recent events. The same turn also got the agents you know and trust, your motebit's self-model, reminders of memories that are fading, your installed skills, and live facts about your session such as the page your browser had open. A caller could ask the model to repeat any of it. The same was true of a customer's `motebit_task` and of any approval such a turn waited on.

Now another principal's turn recalls none of your memories and gets none of that context. It still has your motebit's identity and persona, the tools it is allowed to use, and the model it runs on. As a result, a served query can no longer answer from what you have told your motebit. If you want strangers to be answered from some of your motebit's knowledge, that needs an explicit "shareable" setting on the memories you choose. That setting does not exist yet, and it will never be on by default.

`motebit_recall` no longer returns your memories to other agents. It is the MCP tool `motebit serve` exposes for memory search, and the `motebit://memories` resource is its sibling. Before this fix, any caller with access to your server could search your memories (none and personal tier) directly. Now both answer only you: a stdio session on your own machine, or a caller whose verified motebit token is your motebit's own identity. Every other caller gets a refusal and no memory content. That includes another motebit, the relay, and anyone using a shared static bearer token.

`motebit_remember` is unchanged: a caller can still store a memory in your motebit, and it is always marked as coming from a peer agent, never from you.
