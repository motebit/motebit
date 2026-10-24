---
"@motebit/desktop": patch
---

Desktop Rust dependencies resolved by `cargo update` to one consistent set: tauri 2.12.5, wry 0.57, tao 0.37. That set clears the Dependabot alerts for openssl (0.10.81), rustls (0.23.46), rustls-webpki (0.103.16), quinn-proto (0.11.19), serde_with (3.24) and rand (0.8.8, 0.9.5). `@tauri-apps/api` and `@tauri-apps/cli` move to 2.12.4 so the npm and Rust sides stay on the same minor. The Silero VAD model, its worklet and the ONNX Runtime WASM are now copied to the `dist/` root that `voice.ts` loads them from (`rename: { stripBase: true }`). Since vite-plugin-static-copy v4 they had landed under `dist/node_modules/…`, which Tauri CLI 2.12 now refuses to bundle.
