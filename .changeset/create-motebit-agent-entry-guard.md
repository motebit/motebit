---
"create-motebit": patch
---

Fix the generated agent's entry-point guard being symlink-fragile.

`makeAgentEntrypoint` emitted `const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)` into every scaffolded agent's `src/index.ts`. Launched through a symlink (a global bin, `npx`), `process.argv[1]` is the link while `import.meta.url` is the realpath, so the compare is false, the `if (isMainModule)` serve-spawn never fires, and the agent silently never starts — the same class as the `@motebit/verify` 1.7.7 and `relay-key` entry-guard sev-1s found in the same sibling audit.

The guard now compares realpaths (`realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])`), so the agent starts when launched through any path. Recursion prevention is preserved: when `motebit serve --tools <path>` re-imports the file for its tool defs, `argv[1]` is the `motebit` binary (a different realpath), so the guard is correctly false. The existing scaffold regression test (which read the generated file and asserted the _fragile_ pattern — a test coupled to the bug) is updated to lock the realpath-robust pattern and assert the fragile one is gone.
