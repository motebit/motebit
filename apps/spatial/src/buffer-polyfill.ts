// Buffer polyfill for @solana/web3.js + @solana/spl-token (pulled in via
// @motebit/wallet-solana). These Solana libraries reference Node's `Buffer`
// as a global at module-eval time, which doesn't exist in the browser /
// WebXR webview.
//
// Imported as the FIRST side-effect import of `app.ts` so it evaluates before
// any Solana-touching module — without it, the spl-token import throws
// `ReferenceError: Buffer is not defined` at load, kills the module graph, and
// spatial boots to a blank canvas. Mirrors apps/web + apps/desktop —
// sibling-boundary rule: same fix, same shape, every browser surface.
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
