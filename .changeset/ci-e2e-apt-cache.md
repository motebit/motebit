---
---

The CI `e2e` job caches the apt packages `playwright install --with-deps` adds and seeds them into apt's archive, so a normal run no longer fetches 17.5 MB of fonts from a slow mirror. The installed packages, and so the golden frames' fonts, are unchanged. CI configuration only: no published package changes.
