# Vendored Vercel `vercel.json` schema

`vercel.schema.json` is what `scripts/check-vercel-ignore-build.ts` validates
every `vercel.json` in the repo against, so a config Vercel would refuse
(an `ignoreCommand` longer than its `maxLength`, an unknown top-level key)
goes red in CI instead of failing the deployment. Incident: PR #1027's
motebit-web preview failed before building with `ignoreCommand should NOT be
longer than 256 characters`, while every repo test and gate was green —
and `vercel --prod` in `deploy-web.yml` reads the same file.

- **Source:** https://openapi.vercel.sh/vercel.json (Vercel's published schema).
- **Status:** INTERIM SUBSET (2026-10-02). The session that added the gate
  could not reach `openapi.vercel.sh` (blocked by its network egress policy),
  so the committed file is hand-written and says so in its `$comment`. Its
  `ignoreCommand.maxLength` (256) comes from Vercel's own error message.
  Refresh it from the source before relying on anything beyond that.

## Refreshing

```bash
npx tsx scripts/refresh-vercel-schema.ts   # fetches the source URL, stamps $comment with URL + date
pnpm check-vercel-ignore-build             # every vercel.json still validates
npx vitest run scripts/__tests__/check-vercel-ignore-build.test.ts
```

Commit the result. The gate reads every limit from the file (it never
hardcodes one), so a refresh that changes a limit changes the gate.
