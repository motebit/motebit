---
"create-motebit": patch
---

Fix test assertion that coupled create-motebit's own version to the
`@motebit/crypto` version pinned in scaffold output. The pre-fix
release.yml run failed at `Test published packages`:

```text
AssertionError: expected '^1.1.0' to be '^1.1.1'
  Expected: "^1.1.1"
  Received: "^1.1.0"
```

The assertion `expect(pkg.dependencies["@motebit/crypto"]).toBe(\`^${VERSION}\`)`asserted the scaffolded crypto pin equals create-motebit's own`PKG.version`. That coupling held by accident before the fix in the
prior commit because the misnamed `**VERIFY_VERSION**` constant made
all three pinned versions identical to crypto's. After the fix, each
package pins its actual published version (crypto 1.1.0, sdk 1.0.1,
motebit 1.0.1, create-motebit's own version independent).

Test now reads `@motebit/crypto`'s package.json directly and asserts
the scaffold pins `^${CRYPTO_VERSION}` — same source of truth tsup uses
to inject `__CRYPTO_VERSION__` at build time. Decouples the test from
the coincidence.

48/48 create-motebit tests pass.
