---
"@motebit/relay": patch
---

`close()` now ends the x402 facilitator handshake the relay starts at boot. `registerTaskRoutes` runs `x402HTTPResourceServer.initialize()` (`GET <facilitator>/supported`) without awaiting it, and `close()` used to leave it running. A slow or rate-limited facilitator could then answer after the relay had closed, and `@x402/core` would `console.warn` the failure from a relay that no longer existed. In the relay test suite that late warn caused `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`. `registerTaskRoutes` now returns a handle. Its `close()` aborts a pending `getSupported()` through `abortGetSupportedOn`; `verify` and `settle` are never cut short. The handle's `close()` then waits for the handshake to finish, and the relay's `close()` waits for the handle before closing the database.
