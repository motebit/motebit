---
"motebit": patch
---

Scheduled goal runs obey the send tier. A goal written at a medical, financial or secret tier runs only on an on-device provider; on an external provider the run is refused with the reason, like a plan or paused approval produced at that tier. A run's prompt carries the saved summaries of earlier runs, the parent / sibling / sub-goal / project context and the memories recalled for its plan only when the send tier permits the tier they were produced at. Run outcomes, sub-goals the model writes and the memory formed from a run's outcome are stamped with the tier of the run that produced them. A legacy (unstamped) run summary is withheld below `secret`; a legacy sub-goal is held at `secret`; a legacy top-level goal is held at `personal`.
