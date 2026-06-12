/**
 * Bridged organs → coordinator tools: the consumer step of capability
 * bridging (docs/doctrine/daemon-desktop-unification.md, the increment-3
 * recorded residual). An attached frontend's contributed organs become
 * tools in the coordinator's registry — visible to the AI loop and
 * policy-gated by the SAME gate as every local tool, with explicit
 * canonical metadata (never regex-inferred risk), and removed the moment
 * the contributing frontend disconnects.
 *
 * Layering: this module owns the MECHANICS — which organs are currently
 * bridged, execution over the bridge, fail-closed classification. The
 * ToolDefinitions are INJECTED at the registration site by the hosting
 * surface: this package's dependency floor is protocol + crypto, the
 * canonical definitions live in `@motebit/tools`, and the embodiment
 * stamp deliberately belongs to the registration site (the per-dispatcher
 * stamping discipline of `docs/doctrine/motebit-computer.md`).
 */

import type { ToolDefinition, ToolRegistry, ToolResult } from "@motebit/protocol";
import type { RuntimeHostServer } from "./server.js";

/**
 * Organs that must NEVER surface to the AI loop as tools, with the
 * reason each is excluded. These are deterministic user affordances
 * (`docs/doctrine/surface-determinism.md`): they execute through typed
 * capability flows the user initiates, never by model choice. Injecting
 * a ToolDefinition for one of these throws at wire time — fail-closed
 * even against a confused hosting surface.
 */
export const AI_LOOP_EXCLUDED_ORGANS: ReadonlyMap<string, string> = new Map([
  [
    "se_attestation",
    "hardware-attestation minting is a user-initiated identity affordance " +
      "(docs/doctrine/hardware-attestation.md), never a model-chosen act",
  ],
]);

/**
 * Capability name → the ToolDefinition the coordinator surfaces for it.
 * The tool's `name` may differ from the capability (the bridged
 * `computer_use` organ surfaces as the canonical `computer` tool so the
 * model, the prompt, and the policy gate treat it exactly like the
 * desktop-local registration).
 */
export type BridgedOrganDefinitions = Readonly<Record<string, ToolDefinition>>;

function isToolResultShaped(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

/**
 * A read-only ToolRegistry view over the organs currently bridged into
 * `server` that have an injected definition. `list()` reflects the live
 * bridged set, so re-registering on every capabilities change keeps the
 * coordinator's tools current. Execution streams over the bridge and
 * fails honestly — a contributor disconnect mid-invocation surfaces as
 * `ok: false` with the reason, never a silent retry across the
 * authority boundary.
 */
export function bridgedToolRegistry(
  server: RuntimeHostServer,
  definitions: BridgedOrganDefinitions,
): ToolRegistry {
  for (const capability of Object.keys(definitions)) {
    const exclusion = AI_LOOP_EXCLUDED_ORGANS.get(capability);
    if (exclusion !== undefined) {
      throw new Error(
        `bridged organ "${capability}" must not surface to the AI loop as a tool: ${exclusion}`,
      );
    }
  }

  const exposed = (): Array<{ capability: string; definition: ToolDefinition }> =>
    server.bridgedCapabilities
      .filter((capability) => definitions[capability] !== undefined)
      .map((capability) => ({ capability, definition: definitions[capability]! }));

  return {
    list(): ToolDefinition[] {
      return exposed().map((e) => e.definition);
    },

    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const entry = exposed().find((e) => e.definition.name === name);
      if (entry === undefined) {
        return { ok: false, error: `no attached frontend currently contributes tool "${name}"` };
      }
      const chunks: unknown[] = [];
      try {
        // The prompt slot is empty by design: bridged organ handlers
        // consume typed args (options), never a constructed prompt.
        for await (const chunk of server.invokeBridged(entry.capability, "", args)) {
          chunks.push(chunk);
        }
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const data: unknown = chunks.length === 1 ? chunks[0] : chunks;
      // An organ that already answers in ToolResult shape keeps its own
      // verdict (an honest ok:false from the frontend stays ok:false).
      if (isToolResultShaped(data)) return data;
      return { ok: true, data };
    },

    register(): void {
      throw new Error("bridged tool registry is a read-only view over attached frontends' organs");
    },
  };
}

/**
 * The structural port a coordinator's runtime satisfies (the package
 * cannot import `@motebit/runtime` — hosts wire INTO the runtime, the
 * runtime stays ignorant of hosting). `MotebitRuntime` matches it.
 */
export interface BridgedToolHost {
  registerExternalTools(sourceId: string, registry: ToolRegistry): void;
  unregisterExternalTools(sourceId: string): void;
}

/** Source id bridged organ tools register under in the host's registry. */
export const BRIDGED_ORGAN_TOOL_SOURCE = "runtime-host:bridged-organs";

/**
 * Keep the host's tool registry in sync with the bridged-organ set:
 * register the currently-exposed organs now, and re-register on every
 * capabilities change (a contributor attaching adds its organs; its
 * disconnect removes them — no orphaned tools). Call AFTER the host's
 * runtime exists; returns an unsubscribe.
 */
export function wireBridgedOrganTools(
  server: RuntimeHostServer,
  host: BridgedToolHost,
  definitions: BridgedOrganDefinitions,
): () => void {
  const registry = bridgedToolRegistry(server, definitions);
  const sync = (): void => {
    host.unregisterExternalTools(BRIDGED_ORGAN_TOOL_SOURCE);
    host.registerExternalTools(BRIDGED_ORGAN_TOOL_SOURCE, registry);
  };
  const unsubscribe = server.onBridgedCapabilitiesChanged(sync);
  sync();
  return unsubscribe;
}
