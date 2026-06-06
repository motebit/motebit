---
"@motebit/verifier": patch
---

Expose `./package.json` in the `exports` map.

The exports map listed only `"."`, so `require("@motebit/verifier/package.json")` / `import "@motebit/verifier/package.json"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Some tooling and version-parity checks (e.g. a consumer asserting it pins the same verifier version a sibling site ships) read a dependency's `package.json` directly; this unblocks them. Surfaced by a third-party integrator consuming the package from npm with zero repo access.
