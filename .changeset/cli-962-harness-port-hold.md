---
---

Test-only: the #962 every-configured-surface harness holds each cell's relay port for the cell's life, so a relay elsewhere in the run can no longer bind it while the cell's relay is down and acknowledge the cell's pushes (the intermittent down→up "loss"). No published behavior changes.
