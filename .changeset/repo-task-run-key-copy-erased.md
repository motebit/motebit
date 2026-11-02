---
"@motebit/runtime": patch
---

`runRepoTask` now erases its private copy of the agent key on every exit, completed or thrown. The caller still owns and erases its own buffer; before this, the run's copy lived until garbage collection.
