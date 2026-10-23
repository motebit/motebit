/**
 * Superseded by `credential-store.ts`, the one module that owns the
 * credential store. Kept only as a re-export of the binding rule for
 * existing importers; it holds no SQL and adds nothing.
 */
export { BOUND_ISSUER_SQL, boundCredentialRows, isBoundRow } from "./credential-store.js";
