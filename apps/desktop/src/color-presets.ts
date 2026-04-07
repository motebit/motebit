/**
 * Desktop color presets — re-exports the canonical `COLOR_PRESETS` from
 * `@motebit/sdk`. The module stays around as a barrel so every
 * existing `import { COLOR_PRESETS } from "./color-presets.js"` call
 * site keeps working unchanged; the actual source lives in the sdk
 * (`packages/sdk/src/color-presets.ts`).
 *
 * Keeping this re-export file rather than deleting it is deliberate:
 * `renderer-commands.ts` imports COLOR_PRESETS from here, and the
 * shim gives us one place to change later if the presentation ever
 * diverges from the sdk defaults.
 */

export { COLOR_PRESETS } from "@motebit/sdk";
