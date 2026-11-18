---
"motebit": patch
---

Test-only, no change to the published CLI: the fake relays in the paid-delegation tests answer the payment pre-flight (`p2p-eligibility`) in the shape the relay service returns today (with the amounts to pay), one case keeps the older shape by name, and a new test boots the real relay in-process and requires the fixture to equal the handler's own answer. This file exists because the pre-commit hook requires a changeset beside any change under `apps/cli/src`, tests included.
