// Fixture: the incident's source shape — a provider credential read from a public env var.
const rpc = import.meta.env.VITE_SOLANA_RPC_URL;
const key = import.meta.env.VITE_HELIUS_API_KEY;
export { rpc, key };
