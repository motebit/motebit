import { defineMotebitTest } from "../../vitest.shared.js";

// Election + handshake + proxy protocol over real unix sockets. Every
// failure mode in docs/doctrine/daemon-desktop-unification.md has a
// test; the uncovered remainder is socket-teardown raciness that only
// reproduces under OS scheduling.
export default defineMotebitTest({
  thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
});
