---
"create-motebit": minor
---

`create-motebit` scaffold polish — READMEs, prestart safety, agent verify next-step.

Three smaller gaps from the 2026-04-25 first-time-user walkthroughs (default + agent paths) batched into one polish pass:

**Gap #5 / #A5 — both scaffolds now write a `README.md`.** The "Next steps" output only existed on stdout; closing the terminal lost the instructions. The README is the durable record. Includes the canonical verify commands, the directory contents, the relay-auth model, and pointers to docs + the-stack-one-layer-up doctrine.

**Gap #A6 — agent scaffold's `package.json` adds a `prestart: "tsc"` hook.** Running `npm start` on a clean checkout used to bail with `Cannot find module dist/index.js`. The prestart hook makes `npm start` build first automatically — npm's canonical pattern for "build before start." `start` itself stays a single-line `node dist/index.js` invocation suitable for production runners that pre-build separately.

**Gap #A7 — agent scaffold's "Next steps" output adds a `npm run verify` line.** Default scaffold included this; agent scaffold dropped it. New users had no canonical pointer to verify the agent's `motebit.md` signature before putting it on the network. Now both paths are consistent.

**Default scaffold's `verify` script** also updated to use `npx -p @motebit/verify motebit-verify motebit.md` (matching the agent scaffold and the next-steps output already updated in the previous commit). Replaces the previous `npx create-motebit verify motebit.md` — both work, but the canonical CLI invocation is what users see in next-steps and READMEs everywhere else.

Three new regression tests:

- `default scaffold writes a README documenting verify commands and motebit_id`
- `agent scaffold writes a README and includes prestart for npm start safety`
- `agent scaffold's next-steps output includes a verify step`

48/48 create-motebit tests pass. End-to-end verified locally: scaffold, install, build, verify, run all clean.
