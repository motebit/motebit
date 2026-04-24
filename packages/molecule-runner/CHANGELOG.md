# @motebit/molecule-runner

## 0.2.0

### Minor Changes

- 5df5879: Extract the shared molecule/atom service boot pattern into a new
  `@motebit/molecule-runner` package at Layer 6, and migrate all five
  downstream services (code-review, read-url, research, summarize,
  web-search) to consume it.

  Every service was running the same ~50-line skeleton inline:

        bootstrapAndEmitIdentity()
        openMotebitDatabase()
        new InMemoryToolRegistry()
        new MotebitRuntime(..., NullRenderer)
        wireServerDeps / startServiceServer
        handleAgentTask handler

  Five sibling copies of the same wire — exactly the drift shape the
  `feedback_protocol_primitive_blindness` doctrine names. The boot
  pattern IS a protocol primitive; it belongs in a package, not inline
  in each service. The new `runMolecule(config, buildCallback)` collapses
  boot to a single call; the builder callback receives the bootstrapped
  identity and returns the service-specific `{ toolRegistry,
handleAgentTask?, getServiceListing?, customRoutes?, onStop? }`.

  ### Layer placement

  Added `@motebit/molecule-runner` at Layer 6 (sibling of
  `create-motebit`). Considered and rejected:
  - **(a) Helper inside `@motebit/runtime`** — would bloat a Layer-5
    orchestrator package with filesystem + MCP-server composition that
    isn't runtime-core.
  - **(c) Shared module under `services/`** — service-to-service relative
    imports break layering convention and the sibling-boundary rule.

  Option (b) is clean: a new Layer-6 production slot in
  `scripts/check-deps.ts` (same tier the application kernel
  `create-motebit` already occupies). Services are `APP_LAYER=6` and
  the layer gate explicitly permits app-layer → app-layer production
  deps — no deeper mechanism change needed.

  ### Service changes

  Each service's `src/index.ts` shrunk to env-config load + tool
  registration + `runMolecule(cfg, (identity) => …)`. The line count for
  `services/code-review/src/index.ts` dropped from 289 to 215 (-26%);
  the skeleton that used to dominate the file is now a single function
  call. No wire-format behavior changed — same MCP surface, same signed
  receipts, same relay registration, same R3-auto policy default.

  Services now depend on `@motebit/molecule-runner` in production and
  carry their former deep-package imports (`@motebit/runtime`,
  `@motebit/persistence`, `@motebit/encryption`, etc.) as devDependencies
  for test fixtures that still exercise the lower layers directly. The
  existing `check-service-primitives` gate continues to enforce that
  protocol plumbing is never reinvented inline — this change tightens
  that doctrine by moving one more primitive (the boot pipeline itself)
  out of service source.

  ### Coverage

  `@motebit/molecule-runner` ships with 25 tests covering the happy
  boot path, identity propagation, adapter-slot injection (DB, runtime,
  server, embed), shutdown behavior (runtime.stop + DB close + private
  key zeroing + molecule onStop + error recovery), optional-field
  passthrough (authToken, syncUrl, customRoutes, getServiceListing,
  policyOverrides), and the default-fallback branches. Coverage:
  100% statements / 100% lines / 100% functions / 81.81% branches
  (threshold 80).

  Docs tree (`apps/docs/content/docs/operator/architecture.mdx`) and
  root CLAUDE.md package count updated to 40 packages. No permissive-floor package
  touched; no BSL→permissive-floor import introduced.

### Patch Changes

- Updated dependencies [699ba41]
- Updated dependencies [e897ab0]
- Updated dependencies [09737d7]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [009f56e]
- Updated dependencies [356bae9]
- Updated dependencies [06b61e8]
- Updated dependencies [620394e]
- Updated dependencies [78f7d69]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [4ea58fd]
- Updated dependencies [e17bf47]
- Updated dependencies [c757777]
- Updated dependencies [58c6d99]
- Updated dependencies [54e5ca9]
- Updated dependencies [a801771]
- Updated dependencies [7fbdc48]
- Updated dependencies [be2dba3]
- Updated dependencies [403fee0]
- Updated dependencies [1e07df5]
- Updated dependencies [f0a86c7]
- Updated dependencies [cbb61d1]
  - @motebit/sdk@1.0.0
  - @motebit/tools@0.2.0
  - @motebit/runtime@0.2.0
  - @motebit/mcp-server@0.1.18
  - @motebit/memory-graph@0.2.0
  - @motebit/persistence@0.1.18
