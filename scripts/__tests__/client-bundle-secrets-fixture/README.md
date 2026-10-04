# client-bundle-secrets fixture

Fixture apps for `scripts/check-no-secrets-in-client-bundles.ts`. `dist/` is
gitignored, so each app commits its built output as `dist-template/`; the test
copies `<app>/src` + `<app>/dist-template` into a temp `apps/<app>/{src,dist}`
root and runs the gate with `--root`.

- `leaky/` — the 2026-09-30 incident, exactly: source reads a credential-named
  `VITE_*` var, and the built bundle carries
  `https://mainnet.helius-rpc.com/?api-key=<uuid>` (an all-zero, fake uuid).
- `clean/` — a correct surface: a plain public URL env var and a bundle whose
  Solana RPC is the server-side passthrough. Must NOT be flagged.
