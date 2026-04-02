/** Ambient declarations for optional runtime dependencies.
 *  These modules are detected at runtime via dynamic import in try/catch.
 *  Declaring them here lets TypeScript resolve the import without
 *  requiring the package to be installed. */

declare module "@xenova/transformers";
