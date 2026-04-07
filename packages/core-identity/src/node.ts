/**
 * Node-only entry point for @motebit/core-identity.
 *
 * These adapters import node:fs / node:path and MUST NOT be included
 * in browser bundles. Import from `@motebit/core-identity/node` in
 * services, CLI, and any other Node-only code.
 */

export { FileSystemBootstrapConfigStore, FileSystemBootstrapKeyStore } from "./file-stores.js";
export {
  bootstrapServiceIdentity,
  type BootstrapServiceIdentityOptions,
  type BootstrapServiceIdentityResult,
} from "./bootstrap-service.js";
