/**
 * The model lists a relay-minted proxy token carries, by funding source.
 * The lists live in `@motebit/sdk` (`MOTEBIT_CLOUD_TOKEN_MODELS`) beside the
 * Cloud admission rule, so the relay mints, the proxy enforces and every
 * client admits from one table (#654 cold review R3). Pure (no I/O).
 */
import { MOTEBIT_CLOUD_TOKEN_MODELS } from "@motebit/sdk";

/** Models a token may name once the account has REAL funding. */
export const DEPOSIT_MODELS: readonly string[] = MOTEBIT_CLOUD_TOKEN_MODELS.deposit;

/** Models a token may name while the account holds ONLY the welcome credit. */
export const FREE_CREDIT_MODELS: readonly string[] = MOTEBIT_CLOUD_TOKEN_MODELS["free-credit"];

/** The list a token is minted with: the funded ceiling, or the welcome-credit one. */
export function modelsForFunding(realFunding: boolean): string[] {
  return [...MOTEBIT_CLOUD_TOKEN_MODELS[realFunding ? "deposit" : "free-credit"]];
}
