/**
 * Side-effect-only module that installs Node-shaped globals Hermes doesn't
 * ship: crypto (Web Crypto API via react-native-quick-crypto's JSI bindings)
 * and Buffer (via @craftzdog/react-native-buffer's JSI-backed polyfill).
 *
 * Must be imported BEFORE any module that touches these globals at load
 * time. ESM within a single file hoists every `import` declaration above
 * top-level statements, so installing globals inside index.ts runs AFTER
 * App's dependency tree has already evaluated. Extracting into a separate
 * module makes this safe: the import-then-import order across files is
 * sequential (this module fully evaluates before the next import begins).
 *
 * Why both globals are here (not in separate shims):
 *   - Keeps the "install side-effect globals" concern in one file.
 *   - index.ts is a single `import "./shims/install-globals"` at the top.
 *   - Order within this file is irrelevant: neither polyfill depends on
 *     the other, and top-level statements run after both imports resolve.
 *
 * Load-time access patterns that make this non-optional:
 *   - @solana/spl-token constructs token program IDs via Buffer.from(base58)
 *     at module load — Buffer must be global BEFORE wallet-solana imports.
 *   - react-native-quick-crypto is installed proactively even though most
 *     getRandomValues calls are function-time; cheap to set up and removes
 *     any future footgun.
 */

import crypto from "react-native-quick-crypto";
import { Buffer } from "@craftzdog/react-native-buffer";

if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error -- quick-crypto's type doesn't perfectly match Web Crypto but is compatible
  globalThis.crypto = crypto;
}

if (typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer: unknown }).Buffer = Buffer;
}
