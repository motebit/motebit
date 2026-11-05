---
---

The CI `e2e` job gives each step its own time budget (Playwright install 12m, smoke tests 3m, golden-matrix build 3m, golden frames 7m) under a 20m job ceiling, instead of one 10m ceiling the whole job shares. A slow apt mirror during `playwright install --with-deps` twice cancelled e2e before any test ran. CI configuration only: no published package changes.
