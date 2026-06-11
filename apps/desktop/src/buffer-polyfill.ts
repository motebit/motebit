// Buffer polyfill for @solana/web3.js + @solana/spl-token (pulled in via
// @motebit/wallet-solana). These Solana libraries reference Node's `Buffer`
// as a global at module-eval time, which doesn't exist in the Tauri webview.
//
// Imported as the FIRST side-effect import of `main.ts` so it evaluates
// before any Solana-touching module — the same "run before any module
// import" guarantee the former inline <script> in index.html provided.
// Externalized so the desktop CSP can forbid inline script
// (`script-src 'self'`, the XSS→RCE backstop) without breaking the wallet.
// Mirrors apps/web — sibling-boundary rule.
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
