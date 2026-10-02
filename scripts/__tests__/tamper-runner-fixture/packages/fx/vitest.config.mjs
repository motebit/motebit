// Fixture tests are *.fx.mjs so the monorepo's own vitest never collects them.
export default { test: { include: ["*.fx.mjs"] } };
