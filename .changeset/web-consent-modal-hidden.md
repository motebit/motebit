---
---

Web: the closed "Install Sensitive Skill?" consent modal is hidden with `visibility: hidden`, not only `opacity: 0`, so it leaves the accessibility tree and the tab order until it opens, as the Settings, PIN and Restore dialogs already do. A new test checks every dialog in `apps/web/index.html`. App only: no published package changes.
