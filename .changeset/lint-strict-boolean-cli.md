---
"motebit": patch
---

Internal lint cleanup in the CLI — no behavior change. Two
`@typescript-eslint/strict-boolean-expressions` sites made explicit:
`slash-commands.ts` (`!match` → `match == null` on a nullable enum lookup) and
`subcommands/discover.ts` (`capabilities?.length` → `capabilities != null &&
capabilities.length > 0`, keeping a zero-length list correctly falsy). Part of a
repo-wide pass that cleared all 59 pre-existing ESLint warnings; the rest landed
in private packages and don't carry a version.
