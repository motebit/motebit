// A global teardown that makes vitest exit 7 with every test passing.
export default { test: { include: ["*.fx.mjs"], globalSetup: ["./global-setup.mjs"] } };
