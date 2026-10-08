---
"motebit": patch
---

The `list_events` tool now returns only the events the current send tier permits. Previously it returned every event payload, including tool results, memory content and reflections recorded at a medical, financial or secret tier, to whichever provider the session was using. An unstamped event that can carry content is withheld.
