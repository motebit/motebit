import {
  MotebitRuntime,
  RelayDelegationAdapter,
  executeCommand,
  cmdSelfTest,
  PLANNING_TASK_ROUTER,
  resolveProactiveAnchor,
  bindSlabControllerToRenderer,
  createRelayBackedSandboxTokenSource,
  getOrPinRelayKey,
  verifyAgentCommandEnvelope,
} from "@motebit/runtime";
import type { TokenAudience } from "@motebit/sdk";
import { createSolanaWalletRail, createSolanaMemoSubmitter } from "@motebit/wallet-solana";
import type {
  StreamChunk,
  StorageAdapters,
  PlanChunk,
  UserInputForwardResult,
} from "@motebit/runtime";
import {
  renderSlabItem,
  updateSlabItem,
  renderDetachArtifact as renderSlabDetachArtifact,
  releaseLiveBrowserItem,
} from "./ui/slab-items";
import { buildSlabHomeView } from "./ui/slab-home.js";
import { buildIdentityFace } from "./ui/identity-face.js";
import { deriveHomeSeed, type HomeSeedInputs, type HomeTileAction } from "./ui/slab-home-model.js";
import { animateMarkForReceipt } from "./ui/cobrowse-chrome";
import { renderSlabChrome } from "./ui/slab-chrome";
import { urlHasTrustHeld } from "./cookie-host-match.js";
import type { LiveBrowserElementHandle, SlabBodyRegister } from "@motebit/render-engine";
import type {
  ConversationMessage,
  BehaviorCues,
  AgentTask,
  ExecutionReceipt,
  UserInputEvent,
  UserInputForwardedPayload,
} from "@motebit/sdk";
import { DeviceCapability, EventType, BROWSER_SANDBOX_GRANT_AUDIENCE } from "@motebit/sdk";
import type { ByokVendor } from "@motebit/sdk";
import { dispatchByokRouting, formatRoutingChip } from "@motebit/policy";
import { ThreeJSAdapter, buildComputerSessionReceiptArtifact } from "@motebit/render-engine";
import type { AudioReactivity } from "@motebit/render-engine";
import type { StreamingProvider } from "@motebit/ai-core/browser";
import {
  createBrowserStorage,
  IdbConversationStore,
  IdbConversationSyncStore,
  IdbPlanStore,
  IdbPlanSyncStore,
  IdbGradientStore,
  IdbSkillStorageAdapter,
  IdbSkillAuditSink,
  openMotebitDB,
  migrateMotebitId,
} from "@motebit/browser-persistence";
import { SkillRegistry } from "@motebit/skills";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import { McpClientAdapter, AdvisoryManifestVerifier } from "@motebit/mcp-client";
import type { McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import { createWebComputerApprovalFlow } from "./computer-approval.js";
import { registerWebComputerTool, type ComputerToolRegistration } from "./computer-tool.js";
import { clearCookies, loadCookies, saveCookies } from "./encrypted-cookie-store.js";
import type { ComputerSessionReceipt } from "@motebit/sdk";
import { ScreencastFrameBus } from "./screencast-bus.js";
import { setLiveBrowserSuppressionPredicate } from "./ui/slab-items.js";
import {
  bootstrapIdentity,
  rotateIdentityKeys,
  registerDeviceWithRelay,
  announceMotebit,
  writeRestoredIdentity,
  type BootstrapConfigStore,
  type IdentityStorage,
  type AnnounceMotebitResult,
} from "@motebit/core-identity";
import {
  createSignedToken,
  deriveSyncEncryptionKey,
  secureErase,
  bytesToHex,
  hexToBytes,
  generateX25519Keypair,
  buildKeyTransferPayload,
  decryptKeyTransfer,
  checkPreTransferBalance,
  formatWalletWarning,
} from "@motebit/encryption";
import type { KeyTransferPayload } from "@motebit/sdk";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  EncryptedConversationSyncAdapter,
  EncryptedPlanSyncAdapter,
  decryptEventPayload,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  PairingClient,
  type PairingSession,
  type PairingStatus,
  type SyncStatus,
  type CredentialSource,
} from "@motebit/sync-engine";
import {
  registerBrowserSafeBuiltins,
  ProxySearchProvider,
  recallSelfDefinition,
  createRecallSelfHandler,
} from "@motebit/tools/web-safe";
import { querySelfKnowledge } from "@motebit/self-knowledge";
import { embedText, setRemoteEmbedUrl } from "@motebit/memory-graph";
import { CursorPresence } from "./cursor-presence";
import { createProvider, WebLLMProvider, PROXY_BASE_URL } from "./providers";
import type { ProviderConfig } from "./storage";
import {
  needsMigration,
  loadLegacyConversations,
  markMigrationDone,
  loadGovernanceConfig,
  loadProactiveConfig,
  loadColdStartOptIn,
  loadProviderConfig,
  loadSyncUrl,
  DEFAULT_RELAY_URL,
  isAnnounced,
  markAnnounced,
} from "./storage.js";
import { LocalStorageKeyringAdapter } from "./browser-keyring";
import { EncryptedKeyStore } from "./encrypted-keystore";
import { createWebGoalsScheduler } from "./goal-scheduler";
import { createWebGoalsAdapter } from "./goals-adapter";
import type { GoalsEngine } from "./goal-engine";
import { createGoalsController, type GoalsController } from "@motebit/panels";

// Re-export shared presets for color-picker and settings modules
import {
  COLOR_PRESETS,
  APPROVAL_PRESET_CONFIGS,
  inferenceIsFreeToUser,
  defaultProviderConfig,
} from "@motebit/sdk";
import type { InteriorColor } from "@motebit/sdk";
export { COLOR_PRESETS };
export type { InteriorColor };

// Re-export provider utilities
export { createProvider, WebLLMProvider };

// Legacy Tier 1 localStorage key — will be migrated to cryptographic identity
const LEGACY_MOTEBIT_ID_KEY = "motebit-web-id";

export type WebSyncStatus =
  | "offline"
  | "connecting"
  | "connected"
  | "syncing"
  | "error"
  | "disconnected";

export class UnbootedWebApp {
  private renderer = new ThreeJSAdapter();
  private cursorPresence = new CursorPresence();
  protected runtime: MotebitRuntime | null = null;
  /**
   * BYOK auto-router state — second-consumer half of the auto-routing
   * primitive per `docs/doctrine/auto-routing-as-protocol-primitive.md`
   * § "PR 2 — BYOK consumer". When `connectProvider` lands a BYOK
   * config with `autoRoute: true`, the WebApp holds the vendor + a
   * reference to the StreamingProvider so `sendMessageStreaming` can
   * dispatch + `setModel` per turn before forwarding to the runtime.
   *
   * Null when the active provider isn't BYOK + autoRoute — turns then
   * use the user's single configured model (backward-compat default).
   * The dispatch logic lives in `@motebit/policy::dispatchByokRouting`;
   * this class is the consumer site registered in the drift gate
   * `check-routing-decision-coverage` (#95).
   */
  private _byokAutoRouteVendor: ByokVendor | null = null;
  private _currentProvider: StreamingProvider | null = null;
  /**
   * Slab bridge unsub — set after the runtime is constructed and the
   * slab controller is bound to the render adapter via
   * `bindSlabControllerToRenderer(...)`. Called on `stop()` to drop
   * the controller → renderer subscription so the runtime can be
   * replaced without leaking handlers. Null before bind + after unsub.
   * Sibling of `DesktopApp.slabBridgeUnsub`.
   */
  private slabBridgeUnsub: (() => void) | null = null;
  /**
   * Cloud-browser computer-tool registration. `null` when not
   * configured (`VITE_BROWSER_SANDBOX_URL` empty); `dispose()` on
   * `stop()` tears down the cloud Chromium context server-side and
   * emits the closing audit event.
   */
  protected computerRegistration: ComputerToolRegistration | null = null;
  /**
   * Co-browse Slice 2b — disposers wired against the active
   * `coBrowseControl` machine. Two registrations bundled here:
   *   1. `subscribe(...)` for slab-band re-rendering on each
   *      transition, and
   *   2. `motebit:cobrowse-grant` / `-deny` / `-reclaim` document-
   *      level listeners that the slash-command surface dispatches.
   * Both clear in `stop()`. Sibling pattern of `slabBridgeUnsub` and
   * `haltResumeListeners`.
   */
  private coBrowseDisposers: Array<() => void> = [];
  /**
   * v1.3 — single screencast bus per WebApp (v1 cloud-browser
   * dispatcher tracks one cloud session at a time). Producer is the
   * dispatcher's `openScreencast({onFrame})`; consumer is the
   * `live_browser` slab item built per session via
   * `runtime.slab.openItem`.
   */
  private readonly screencastBus = new ScreencastFrameBus();
  /**
   * Stable id of the `live_browser` slab item. The shell mounts ONCE
   * at WebApp boot (right after the cloud-browser registration is
   * built) and lives for the WebApp's lifetime — sessions populate
   * the shell's screencast slot, they don't create the shell.
   * Doctrine: `intent-gated-slab.md` §"Affirmative shape" — the
   * slab's primary embodiment shell precedes content, just like the
   * slab itself precedes acts. `null` only before mount, after
   * dispose, or when the cloud-browser tool isn't configured.
   */
  protected liveBrowserItemId: string | null = null;
  /** Stable id used for the shell — not session-suffixed. */
  private static readonly LIVE_BROWSER_SHELL_ID = "live-browser-shell";
  /**
   * Slice 2d/2f — handle to the mounted live_browser element.
   * Captured via the `onLiveBrowserMount` payload callback. Used
   * by `applyChromeToCurrentState` to mount/clear BOTH the
   * control band and the address bar based on coBrowseControl
   * state. Cleared on WebApp dispose.
   */
  protected liveBrowserHandle: LiveBrowserElementHandle | null = null;
  /**
   * Stable session-aware forward closure mounted on the shell at
   * boot. Reads `_activeBrowserSessionId` lazily so a single closure
   * can serve every transition: pre-session (lazy session-open from
   * URL bar), session-live (direct dispatch), post-session
   * (denied with `session_unavailable`). Mounted ONCE per WebApp.
   */
  private liveBrowserForwardEvent:
    | ((event: UserInputEvent) => Promise<UserInputForwardResult>)
    | null = null;
  /**
   * Cloud-browser session currently attached to the shell, or `null`
   * when no session is live. Set by `attachSessionToLiveBrowser`,
   * cleared by `detachSessionFromLiveBrowser`. The shell's stable
   * forward closure reads this each call so dispatch routes to
   * whatever session is active.
   */
  protected _activeBrowserSessionId: string | null = null;
  /**
   * Phase 1+2 of the persistent user_data_dir arc — cookies-only, now
   * with disk-backed encryption at rest. In-memory cache mirrors what
   * IndexedDB holds; first read lazy-loads from disk; writes update
   * both the cache and (fire-and-forget) the encrypted store.
   *
   * Survives:
   *   - reaper-driven tear-downs of the cloud Chromium (Phase 1)
   *   - tab close + reopen (Phase 2)
   *   - browser restart, even device restart (Phase 2 — local-only;
   *     cross-device sync is a future arc)
   *
   * The encrypted store is per-motebitId so multiple identities in
   * the same origin don't share cookies (sovereign-floor invariant).
   * Non-extractable AES-GCM key in IndexedDB; ciphertext at rest.
   * Same security register as `encrypted-keystore.ts` for the
   * device's private key — strongest browser-native at-rest
   * encryption available.
   *
   * Phase 3 adds the `/cookies status` + `/cookies revoke` slash
   * commands on top of this storage — the user-control affordance
   * over the accumulated browsing trust. No consent gate: cookies
   * stay scoped to the sandbox + the user's device (encrypted at
   * rest), never crossing the AI-provider boundary the way pixels
   * do. Persist-by-default is the right shape; revocation is the
   * user's affordance.
   *
   * Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md`
   * applied to the cloud-browser surface — the structural fix for
   * accumulated browsing trust.
   */
  private _persistedCookies: readonly import("@motebit/runtime").PersistentCookieWire[] = [];
  /**
   * Lazy-load gate for the encrypted cookie store. The first call to
   * `getInitialCookies` triggers a load from IndexedDB and caches
   * the result in `_persistedCookies`. Subsequent reads serve from
   * the cache. Writes update the cache synchronously + persist to
   * disk asynchronously (fire-and-forget; persistence errors don't
   * break the dispose path).
   */
  private _cookieStoreLoadOnce: Promise<void> | null = null;
  /**
   * chrome-1a-fix / prompt-1 — surface-tracked current URL for the
   * open cloud-browser session. Exposed via
   * `runtime.setBrowserSessionProvider(...)` so the AI's prompt's
   * `[Now] Browser: open at <url>` line reads the truth instead of
   * confabulating from conversation memory.
   *
   * Updated from two paths:
   *   1. Motebit-driven navigates — via the
   *      `registerWebComputerTool` `onNavigateResult` callback,
   *      after a successful `computer({kind: "navigate"})` returns
   *      its resolved URL.
   *   2. User-driven navigates — inside
   *      `liveBrowserForwardEvent` after `forwardUserInput` resolves
   *      cleanly on a `{kind: "navigate", url}` event.
   *
   * Reset to `null` on session-ending so a stale URL from a closed
   * session doesn't leak into a fresh session's `[Now]` block.
   *
   * v1 limitation: SPA-style URL changes (in-page click follows a
   * link without an explicit navigate) are NOT tracked. Adding
   * Playwright `framenavigated` events from browser-sandbox is a
   * follow-up slice. Today: explicit-navigate tracking is enough
   * to kill the "browser is on HN" memory-confabulation pattern.
   */
  private _currentBrowserUrl: string | null = null;
  /**
   * Latest task-step narration delivered by the runtime in the current
   * (or most recent) turn. Consumed by the slab's chrome in the
   * `motebit × virtual_browser` register as the chrome's primary
   * content ("Reading the page" / "Filling in the form"). Null when
   * the model hasn't emitted a narration this turn — the register
   * recedes to the empty state.
   *
   * Cleared at turn end (the result chunk) so a stale narration from
   * a previous turn doesn't render against an unrelated state. The
   * runtime's `validateTaskStepNarration` already corrected wire-truth
   * contradictions before this reaches the surface, so the chrome
   * renders the string verbatim. Doctrine:
   * `chrome-as-state-render.md` § "The principle."
   */
  private _taskStepNarration: string | null = null;
  /**
   * Routing-decision chip text — second narration source the chrome
   * absorbs alongside `_taskStepNarration`. Two producer sites
   * populate this slot, depending on tier:
   *
   *   - **BYOK / on-device** — the surface runs the dispatcher
   *     locally in `sendMessageStreaming` before the AI call;
   *     `formatRoutingChip(decision)` formats the chip; assigned
   *     pre-call and applyChromeToCurrentState fires synchronously.
   *
   *   - **motebit-cloud** — the proxy decides at request time and
   *     emits `X-Motebit-Routing-Reason` on the response;
   *     `AnthropicProvider` reads the header via its
   *     `onRoutingReason` callback (wired in `connectProvider`),
   *     assigns the reason to this field, and fires
   *     applyChromeToCurrentState mid-turn as soon as the header
   *     lands. Plain string vs `formatRoutingChip`'s structured
   *     decision; the chrome renders both shapes identically as
   *     opaque chip text.
   *
   * Cleared at turn entry in `sendMessageStreaming` so a stale
   * chip from a prior turn doesn't outlive its decision. Also
   * cleared in `connectProvider` so a config swap (BYOK→cloud /
   * autoRoute on/off) doesn't leak the prior tier's chip.
   *
   * Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
   * § "PR 4 — chrome narration of routing decisions". Closes the
   * three-tier chip-availability asymmetry (BYOK + on-device had
   * the chip; motebit-cloud didn't until this consumer mirror).
   */
  private _routingNarration: string | null = null;
  /**
   * Effective slab-body state machine — two orthogonal axes
   * (URL-derived base + focus-derived overlay) composed into the
   * tri-state the body slot renders:
   *
   *   - `_onHomeRegister`: URL-derived. True when the URL is null
   *     or `about:blank` → body shows the home view as primary
   *     content; screen-mesh visibility derives false (no texture).
   *     False when a real URL is being browsed → screencast occupies
   *     the body.
   *
   *   - `_homeOverlayActive`: focus-derived. True when the URL bar
   *     has focus on top of an active session → home view composites
   *     OVER the screencast (backdrop-blurred, session faintly
   *     visible behind). Esc / blur exits; navigate-commit also
   *     exits naturally because URL state flips to a new real value.
   *
   * Composition: `_onHomeRegister=true` always wins (no overlay
   * needed if home IS the body). `_onHomeRegister=false +
   * _homeOverlayActive=true` is the new transient state for
   * Session→Home transitions without tearing down the session.
   */
  private _onHomeRegister = true;
  private _homeOverlayActive = false;
  private _motebitId = "";
  private _deviceId = "";
  private _publicKeyHex = "";
  /**
   * The orphaned motebit_id when bootstrap detected divergent state on
   * launch (config claimed an identity but the keystore probe came back
   * empty). `null` for the common path. Surfaces the field for the UI
   * to render a recovery banner with restore CTAs. Set once at bootstrap
   * — never updated after — so the banner can be dismissed cleanly by
   * clearing the field via `clearDivergenceNotice()`.
   *
   * Co-load-bearing with [[feedback_sovereignty_primitives_audit_consumers]]
   * and the typed `divergedFromMotebitId` field on `BootstrapResult`.
   */
  private _divergedFromMotebitId: string | null = null;
  private _isProcessing = false;
  private _interiorColor: InteriorColor | null = null;
  private _syncStatus: WebSyncStatus = "offline";
  private _syncStatusListeners = new Set<(status: WebSyncStatus) => void>();
  private _syncUnsubscribe: (() => void) | null = null;
  private _wsAdapter: WebSocketEventStoreAdapter | null = null;
  private _wsTokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _wsUnsubOnEvent: (() => void) | null = null;
  private _wsUnsubOnCustom: (() => void) | null = null;
  private _serving = false;
  private _servingSyncUrl: string | null = null;
  private _activeTaskCount = 0;
  private _localEventStore: StorageAdapters["eventStore"] | null = null;
  /**
   * Held so `restoreIdentity` can pre-write the restored
   * `MotebitIdentity` record + `IdentityCreated` event with the
   * historical bornAt timestamp, before the reload. Without this
   * pre-write, bootstrap's "config has ID, DB doesn't" path fires
   * a fresh event with `timestamp: Date.now()` and the Identity
   * tab's "Born" display lies about the identity's age post-restore.
   */
  private _identityStorage: IdentityStorage | null = null;
  private _planStore: IdbPlanStore | null = null;
  private _planSyncEngine: PlanSyncEngine | null = null;
  private keyStore = new EncryptedKeyStore();
  private mcpAdapters = new Map<string, McpClientAdapter>();
  private _mcpServers: McpServerConfig[] = [];
  private _convStore: IdbConversationStore | null = null;
  private _conversationSyncEngine: ConversationSyncEngine | null = null;
  // Skills registry — IDB-backed so install/list/enable/trust/remove all
  // work without a Node sidecar. Constructed in bootstrap() once IDB is
  // open. Privilege boundary: install + envelope-bytes verification run
  // in this same renderer context, not in an isolated sidecar process —
  // the browser sandbox is the only boundary on web. Same trade-off as
  // mobile; weaker than desktop's Tauri sidecar. See
  // packages/skills/CLAUDE.md rule 5.
  private _skillRegistry: SkillRegistry | null = null;
  // Skill audit sink — durable persistence for `skill_trust_grant`,
  // `skill_remove`, and `skill_consent_granted` events. Wired into
  // both the registry's `audit` option and the panels-side adapter's
  // `audit` option so registry-emitted and adapter-emitted events
  // land in one stream. Closes the consent-gate arc's runtime gap:
  // the protocol type existed but no surface persisted it.
  private _skillAuditSink: IdbSkillAuditSink | null = null;
  private cuesTickInterval: ReturnType<typeof setInterval> | null = null;
  private housekeepingInterval: ReturnType<typeof setInterval> | null = null;
  private idleCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };
  // Tool-invocation bus. The runtime's `onToolInvocation` config
  // fires into this set; `subscribeToolInvocations` adds late-binding
  // listeners (panels, telemetry, devtools). A Set rather than a
  // single callback so multiple observers can share the stream
  // without stomping each other. Errors in individual listeners are
  // isolated — one subscriber's fault must not starve the others.
  private _toolInvocationListeners = new Set<
    (receipt: import("@motebit/crypto").SignableToolInvocationReceipt) => void
  >();
  // Parallel activity bus — delivers the ephemeral raw args/result
  // alongside the signed receipt. Feeds slab-item lifecycle via the
  // projection wrapper in MotebitRuntime. Subscribers must not retain
  // the payload (per the runtime's `onToolActivity` contract — args/
  // result may contain sensitive content that's intentionally not in
  // the signed receipt).
  private _toolActivityListeners = new Set<
    (event: import("@motebit/runtime").ToolActivityEvent) => void
  >();
  // Web's goals daemon — user-declared outcomes the motebit pursues on
  // cadence (recurring) or on demand (once). The in-process engine owns
  // the tick/fire loop + localStorage; started in bootstrap() after the
  // runtime is ready. Fires drive the normal chat pipeline so runs produce
  // signed ExecutionReceipts via the existing seam. The Goals panel binds
  // to `_goalsController` (uniform with desktop/mobile); the engine
  // surfaces only for run records (the "running" pulse) and the once-goal
  // live-progress runNow path. See `docs/doctrine/goals-vs-tasks.md`.
  private _scheduler: GoalsEngine | null = null;
  private _goalsController: GoalsController | null = null;
  // Microtask-coalesce engine emits into one controller.refresh so a
  // single fire (appendRun → updateRun → updateGoal = 3 emits) doesn't
  // thrash the panel through 3 list re-reads.
  private _goalsRefreshQueued = false;

  async init(canvas: HTMLCanvasElement, initialTheme: "light" | "dark" = "light"): Promise<void> {
    try {
      await this.renderer.init(canvas);
      // One world, two times of day: the environment follows the UI theme
      // (dark theme = the designed-night ENV_DARK — a moonlit sky the
      // transmissive body stays legible in, per creature-canon.md's dark
      // environment acceptance criterion; proven by the dark golden frames).
      if (initialTheme === "dark") {
        this.renderer.setDarkEnvironment();
      } else {
        this.renderer.setLightEnvironment();
      }
      this.renderer.enableOrbitControls();
    } catch {
      // WebGL unavailable (headless browser, low-end device).
      // Chat, identity, and all non-3D features still work.
    }
  }

  async bootstrap(): Promise<void> {
    // v1.3 hardening — register the per-action `tool_call`
    // suppression predicate so the slab renderer hides duplicate
    // `computer` cards while a live screencast owns the slab.
    // Predicate fires per-item: per-action cards are visible until
    // the first frame lands (fallback path for screencast failure),
    // hidden after frames flow (no slideshow over the live surface).
    // Doctrine: motebit-computer.md §"v1 implementation status —
    // virtual_browser v1.3 live screencast."
    setLiveBrowserSuppressionPredicate(() => {
      if (this.liveBrowserItemId === null) return false;
      return this.screencastBus.hasFrame();
    });

    // Configure semantic embeddings via proxy (browser can't load ONNX model locally)
    setRemoteEmbedUrl(`${PROXY_BASE_URL}/v1/embed`);

    // Open IndexedDB storage
    const storage = await createBrowserStorage();
    // Ring 2 privacy contract: storage must expose an EventStoreAdapter and
    // an AuditLogAdapter so the runtime can honor the fail-closed privacy
    // doctrine at its boundaries. Enforced statically by check-privacy-ring.
    const _eventStore: EventStoreAdapter = storage.eventStore;
    const _auditLog: AuditLogAdapter = storage.auditLog;
    void _eventStore;
    void _auditLog;

    // Bootstrap cryptographic identity
    const configStore: BootstrapConfigStore = {
      read() {
        const mid = localStorage.getItem("motebit:motebit_id");
        if (mid == null) return Promise.resolve(null);
        return Promise.resolve({
          motebit_id: mid,
          device_id: localStorage.getItem("motebit:device_id") ?? "",
          device_public_key: localStorage.getItem("motebit:device_public_key") ?? "",
        });
      },
      write(state): Promise<void> {
        localStorage.setItem("motebit:motebit_id", state.motebit_id);
        localStorage.setItem("motebit:device_id", state.device_id);
        localStorage.setItem("motebit:device_public_key", state.device_public_key);
        return Promise.resolve();
      },
    };

    const result = await bootstrapIdentity({
      surfaceName: "Web",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore: this.keyStore,
    });

    this._motebitId = result.motebitId;
    this._deviceId = result.deviceId;
    this._publicKeyHex = result.publicKeyHex;
    this._divergedFromMotebitId = result.divergedFromMotebitId ?? null;
    this._localEventStore = storage.eventStore;
    this._identityStorage = storage.identityStorage;

    // Skills registry + audit sink — both share the same IDB handle.
    // The audit sink wires into the registry's `audit` option AND will
    // be passed to the panels-side `RegistryBackedSkillsPanelAdapter`
    // (the panel constructs the adapter with `audit: sink.record` so
    // both registry-emitted events and adapter-emitted consent grants
    // land in one stream). Stays null on IDB-open failure;
    // getSkillRegistry() returns null and the panel displays the
    // typed-error path. See `IdbSkillStorageAdapter` for the
    // privilege-boundary doctrine + `IdbSkillAuditSink` for the audit
    // shape.
    try {
      const skillsDb = await openMotebitDB();
      this._skillAuditSink = new IdbSkillAuditSink(skillsDb);
      await this._skillAuditSink.preload();
      this._skillRegistry = new SkillRegistry(new IdbSkillStorageAdapter(skillsDb), {
        audit: this._skillAuditSink.record,
      });
    } catch {
      this._skillRegistry = null;
      this._skillAuditSink = null;
    }

    // Tier 1 → Tier 2 migration: re-associate existing IDB conversations
    await this.migrateTier1Identity(storage);

    // Migrate legacy localStorage conversations to IDB
    if (needsMigration()) {
      this.migrateLegacyConversations(storage);
    }

    // Preload caches for sync access
    const convStore = storage.conversationStore as IdbConversationStore;
    this._convStore = convStore;
    await convStore.preload(this._motebitId);
    const planStore = storage.planStore as IdbPlanStore;
    this._planStore = planStore;
    await planStore.preload(this._motebitId);
    const gradientStore = storage.gradientStore as IdbGradientStore;
    await gradientStore.preload(this._motebitId);

    // Create runtime — no AI provider yet, will be set via connectProvider()
    const keyring = new LocalStorageKeyringAdapter();
    const govConfig = loadGovernanceConfig();
    const preset = govConfig
      ? (APPROVAL_PRESET_CONFIGS[govConfig.approvalPreset] ?? APPROVAL_PRESET_CONFIGS.balanced!)
      : APPROVAL_PRESET_CONFIGS.balanced!;

    // Load identity signing keys so the runtime can construct the sovereign
    // Solana wallet (settlement-v1.md §6). The Ed25519 seed is the same 32
    // bytes that sign identity assertions — Solana derives its address from
    // this via Keypair.fromSeed (curve coincidence). Best-effort: if the
    // keystore has no key (fresh install, unlocked-but-migrated state), the
    // runtime runs without a wallet and the UX shows an em dash.
    let signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined;
    try {
      const privateKeyHex = await this.keyStore.loadPrivateKey();
      if (privateKeyHex != null && privateKeyHex !== "" && this._publicKeyHex !== "") {
        const privBytes = new Uint8Array(privateKeyHex.length / 2);
        for (let i = 0; i < privateKeyHex.length; i += 2) {
          privBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
        }
        const pubBytes = new Uint8Array(this._publicKeyHex.length / 2);
        for (let i = 0; i < this._publicKeyHex.length; i += 2) {
          pubBytes[i / 2] = parseInt(this._publicKeyHex.slice(i, i + 2), 16);
        }
        signingKeys = { privateKey: privBytes, publicKey: pubBytes };
      }
    } catch {
      // Keystore read failed. Runtime runs without signing keys; wallet UX
      // gracefully shows em dash. User can still use the app for everything
      // else. Re-attempting at next bootstrap.
    }

    // Solana RPC endpoint. The public `api.mainnet-beta.solana.com` is a
    // BROWSER DEAD-END: it 403s cross-origin browser requests, so it can read
    // neither the sovereign balance nor broadcast the P2P payment tx — every
    // onchain op from the web surface needs a browser-capable (CORS-enabled)
    // provider. Set VITE_SOLANA_RPC_URL to a real endpoint (Helius/Triton/
    // QuickNode — free tiers allow browser origins) in any deployment that
    // does onchain work. The default is kept only as a last-resort fallback;
    // when it fails, the balance read surfaces "—"/Couldn't refresh (never a
    // false $0 — see fetchSolanaBalanceUsdc), and onchain sends error loudly.
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const solanaRpcUrl = env?.VITE_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

    // Proactive interior — defaults ON when inference is free to the user
    // (on-device / BYOK), opt-in on metered motebit-cloud. The default is
    // derived from the persisted provider mode (the runtime connects its
    // provider post-construction via connectProvider, so the last-used mode
    // is the right signal); an explicit stored toggle always wins. Policy
    // lives in the SDK's `inferenceIsFreeToUser` so it can't drift across
    // surfaces. Mirrors desktop/mobile wire shape (capability rings: ring 1
    // identical everywhere). Anchor policy resolves through the runtime's
    // shared helper so producer + consumer + submitter stay one source.
    const persistedProviderMode = (loadProviderConfig() ?? defaultProviderConfig()).mode;
    const proactive = loadProactiveConfig(inferenceIsFreeToUser(persistedProviderMode));
    // Construct the sovereign Solana rail + anchor submitter at the surface and
    // inject them; the runtime consumes the `SovereignWalletRail` port and no
    // longer depends on @motebit/wallet-solana (issue #110). The address is the
    // identity pubkey by curve coincidence, so the rail derives from the seed.
    const solanaWallet =
      signingKeys != null
        ? createSolanaWalletRail({ rpcUrl: solanaRpcUrl, identitySeed: signingKeys.privateKey })
        : undefined;
    let anchorSubmitter: ReturnType<typeof createSolanaMemoSubmitter> | undefined;
    if (proactive.anchorOnchain && signingKeys != null) {
      try {
        anchorSubmitter = createSolanaMemoSubmitter({
          rpcUrl: solanaRpcUrl,
          identitySeed: signingKeys.privateKey,
        });
      } catch {
        // Submitter construction failure falls through to local-only anchoring.
      }
    }
    const proactiveAnchor = resolveProactiveAnchor({
      proactiveEnabled: proactive.enabled,
      signingKeys,
      submitter: anchorSubmitter,
    });

    this.runtime = new MotebitRuntime(
      {
        motebitId: this._motebitId,
        tickRateHz: 2,
        policy: {
          operatorMode: false,
          maxRiskLevel: preset.maxRiskLevel,
          requireApprovalAbove: preset.requireApprovalAbove,
          denyAbove: preset.denyAbove,
          budget: govConfig ? { maxCallsPerTurn: govConfig.maxCallsPerTurn } : undefined,
        },
        memoryGovernance: govConfig
          ? {
              persistenceThreshold: govConfig.persistenceThreshold,
              rejectSecrets: govConfig.rejectSecrets,
              maxMemoriesPerTurn: govConfig.maxMemoriesPerTurn,
            }
          : undefined,
        taskRouter: PLANNING_TASK_ROUTER,
        signingKeys,
        solanaWallet,
        // Deferred memory formation — desktop flipped first
        // (c931fefa); web joins to complete one-pass delivery of the
        // autoDream-shape path. Turns return as soon as the response
        // streams; embedding + consolidation run in the background
        // queue; the next turn's pre-idle barrier preserves graph
        // consistency. See packages/runtime/src/memory-formation-queue.ts.
        deferMemoryFormation: true,
        // Proactive interior — defaults off; user opts in via Settings →
        // Governance → Proactive Interior. When enabled, idle-tick fires
        // the consolidation cycle; when anchorOnchain is also on,
        // batches publish to Solana via the SolanaMemoSubmitter
        // constructed inside resolveProactiveAnchor. See
        // `docs/doctrine/proactive-interior.md`.
        proactiveTickMs: proactive.enabled ? 5 * 60_000 : undefined,
        proactiveQuietWindowMs: 90_000,
        proactiveAction: proactive.enabled ? "consolidate" : "none",
        proactiveAnchor,
        // Tool-invocation bus: the runtime signs a
        // ToolInvocationReceipt per tool call; we fan it out to every
        // subscriber. Consumers (panels, telemetry, audit UIs) join
        // the bus via `subscribeToolInvocations` after bootstrap.
        onToolInvocation: (receipt) => {
          for (const listener of this._toolInvocationListeners) {
            try {
              listener(receipt);
            } catch {
              // Subscriber faults are isolated — a broken panel
              // listener must not poison the bus for the others.
              // Callers log at their layer.
            }
          }
        },
        // Parallel activity bus — raw args/result for slab-item
        // lifecycle via the projection wrapper, and any surface
        // subscriber wiring live UI off tool activity. Same fan-out +
        // isolation as the receipt bus.
        onToolActivity: (event) => {
          for (const listener of this._toolActivityListeners) {
            try {
              listener(event);
            } catch {
              // Same isolation rationale as the receipt bus.
            }
          }
        },
      },
      { storage, renderer: this.renderer, ai: undefined, keyring },
    );

    // Web surface: HTTP MCP only (no stdio, no filesystem, no secure keyring)
    this.runtime.setLocalCapabilities([DeviceCapability.HttpMcp]);

    // Hardware-attestation peer flow stays deferred on web — the verifier
    // bundle from @motebit/verify still pulls `node:crypto` paths (via
    // @peculiar/x509 / @peculiar/webcrypto inside the chain verifiers). The
    // browser bootstrap survives only because every node:crypto reference
    // along the import graph is now lazy-loaded. The peer-flow hook in
    // bumpTrustFromReceipt stays dormant on web; routing trust falls back
    // to the existing reputation-credential path. Desktop / mobile / spatial
    // wire the peer flow normally — they're Node / native runtimes.

    // Slab ("Motebit Computer") bridge — sibling of DesktopApp's
    // binding (apps/desktop/src/index.ts). runtime.slab emits
    // lifecycle events for stream / tool_call / delegation items; the
    // bridge diffs state and mounts per-item HTMLElements on the
    // Three.js slab plane via the four RenderAdapter methods. Per-
    // kind renderers in ./ui/slab-items.ts stay out of this file.
    // Doctrine: docs/doctrine/motebit-computer.md.
    this.slabBridgeUnsub = bindSlabControllerToRenderer({
      controller: this.runtime.slab,
      renderer: this.renderer,
      renderItem: renderSlabItem,
      updateItem: updateSlabItem,
      // Inject the removeArtifact closure so receipt artifacts emerging
      // via slab-pinch can wire their dismiss button through the same
      // ArtifactManager path used by the addArtifact fallback. One
      // dismissal mechanism, two emergence physics.
      renderDetachArtifact: (item, kind) =>
        renderSlabDetachArtifact(item, kind, (artifactId) => this.removeArtifact(artifactId)),
      // Kind-specific cleanup at item end. Closes the lifecycle-
      // binding gap from 2026-05-11 — the renderer removed the DOM
      // on phase=gone but per-kind disposers (WebSocket subscription
      // unbind, input-capture detach) were never fired. Each kind
      // dispatches to its own teardown; adding a new kind with
      // resources to release means adding one case below.
      onItemGone: (item) => {
        switch (item.kind) {
          case "live_browser":
            releaseLiveBrowserItem(item.id);
            break;
          default:
            // No per-kind teardown for other kinds today.
            break;
        }
      },
    });

    // Mount the identity face on the slab's back — the sovereign's mark, shown
    // as the camera orbits behind (front = what it does, back = whose it is).
    // Static per identity; set once here, now that the slab (renderer.init) and
    // the id are both ready. The render-engine crossfades it in by camera angle.
    // DOM-gated: headless bootstrap (node tests, workers) has no document and
    // no visible back to dress.
    if (this._motebitId && typeof document !== "undefined") {
      this.renderer.setSlabBackPlate(buildIdentityFace(this._motebitId));
    }

    // Register web-safe tools
    this.registerWebTools();

    // Backfill heuristic titles for any preloaded conversations with
    // null/empty titles — one-shot repair for conversations created
    // before the autoTitle AI-hang fix. Loads messages for every
    // conversation into the sync cache first (the adapter's sync API
    // returns [] otherwise), then runs the heuristic pass. Fire and
    // forget: failure here must not block app boot.
    void (async () => {
      try {
        await this._convStore?.preloadAllMessages();
        const fixed = this.runtime?.backfillMissingConversationTitles() ?? 0;
        if (fixed > 0) {
          // eslint-disable-next-line no-console -- one-shot repair diagnostic for the pre-fix title backfill; fire-and-forget, no UI surface
          console.log(`[conversations] backfilled ${fixed} missing title(s)`);
        }
      } catch (err: unknown) {
        // eslint-disable-next-line no-console -- title backfill must not block boot; failure logged only
        console.warn(
          "[conversations] title backfill failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();

    // Start ticking
    this.runtime.start();
    this.cursorPresence.start();

    // 30fps cursor tick: merge cursor presence into runtime state
    this.cuesTickInterval = setInterval(() => {
      const cursorUpdates = this.cursorPresence.getUpdates();
      if (this.runtime) {
        this.runtime.pushStateUpdate(cursorUpdates);
      }
    }, 33);

    // Periodic housekeeping (memory decay, gradient computation)
    this.housekeepingInterval = setInterval(() => {
      void this.housekeeping();
    }, 10 * 60_000);

    // Reconnect saved MCP servers
    void this.reconnectMcpServers();

    // Start the goals daemon. Fires tab-local; recurring goals fire on
    // cadence, once goals fire on explicit runNow. Each fire drives the
    // normal chat pipeline (plan stream for once goals, single turn for
    // recurring) with suppressHistory so scheduled runs don't land in
    // the user's chat transcript. Pipeline emits signed
    // ExecutionReceipts regardless — audit trail verifiable the same
    // way user-typed runs are. The panel binds to the controller below;
    // the engine surfaces only run records + the once-goal progress path.
    const scheduler = createWebGoalsScheduler(this);
    this._scheduler = scheduler;
    this._goalsController = createGoalsController(createWebGoalsAdapter(scheduler));
    // Background-tick fires mutate the engine directly; nudge the
    // controller to re-read so the panel's list state stays in sync
    // (mirrors desktop, whose scheduler calls ctrl.refresh on complete).
    // Microtask-debounced so one fire's burst of emits = one refresh.
    scheduler.subscribe(() => {
      if (this._goalsRefreshQueued) return;
      this._goalsRefreshQueued = true;
      queueMicrotask(() => {
        this._goalsRefreshQueued = false;
        void this._goalsController?.refresh();
      });
    });
    scheduler.start();
  }

  /**
   * Tier 1 → Tier 2 migration.
   * Existing web users have a `motebit-web-id` localStorage key with a random UUID.
   * After bootstrapIdentity() creates a new cryptographic identity, we re-associate
   * existing IDB conversations with the new motebitId and clean up the old key.
   */
  private async migrateTier1Identity(storage: StorageAdapters): Promise<void> {
    const legacyId = localStorage.getItem(LEGACY_MOTEBIT_ID_KEY);
    if (legacyId == null || legacyId === "") return;

    // Only migrate if this is actually a new identity (different from legacy)
    if (legacyId === this._motebitId) {
      localStorage.removeItem(LEGACY_MOTEBIT_ID_KEY);
      return;
    }

    const convStore = storage.conversationStore as IdbConversationStore | undefined;
    if (convStore) {
      // Preload under the old ID so we can see what needs migrating
      await convStore.preload(legacyId);
      const oldConversations = convStore.listConversations(legacyId);

      if (oldConversations.length > 0) {
        // Re-preload under new ID, then re-associate conversations
        // The IDB store uses motebitId as an index — we need to update the records.
        // Since IdbConversationStore doesn't expose a migration method, we'll
        // re-create conversations under the new identity.
        for (const oldConv of oldConversations) {
          const newConvId = convStore.createConversation(this._motebitId);
          const messages = convStore.loadMessages(oldConv.conversationId);
          for (const msg of messages) {
            convStore.appendMessage(newConvId, this._motebitId, {
              role: msg.role,
              content: msg.content,
            });
          }
          if (oldConv.title) {
            convStore.updateTitle(newConvId, oldConv.title);
          }
        }
      }
    }

    // Remove legacy key — migration complete
    localStorage.removeItem(LEGACY_MOTEBIT_ID_KEY);
  }

  private migrateLegacyConversations(storage: StorageAdapters): void {
    const convStore = storage.conversationStore;
    if (!convStore) {
      markMigrationDone();
      return;
    }

    const legacy = loadLegacyConversations();
    for (const conv of legacy) {
      const convId = convStore.createConversation(this._motebitId);
      for (const msg of conv.messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          convStore.appendMessage(convId, this._motebitId, {
            role: msg.role,
            content: msg.content,
          });
        }
      }
      if (conv.title) {
        convStore.updateTitle(convId, conv.title);
      }
    }

    markMigrationDone();
  }

  private registerWebTools(): void {
    if (!this.runtime) return;
    const runtime = this.runtime;
    const registry = runtime.getToolRegistry();

    const searchUrl =
      ((import.meta as unknown as Record<string, Record<string, string> | undefined>).env
        ?.VITE_SEARCH_URL ?? "https://motebit-web-search.fly.dev") + "/search";

    registerBrowserSafeBuiltins(registry, {
      searchProvider: new ProxySearchProvider(searchUrl),
      readUrlProxy: `${PROXY_BASE_URL}/v1/fetch`,
      memorySearchFn: async (query, limit) => {
        const embedding = await embedText(query);
        const nodes = await runtime.memory.recallRelevant(embedding, { limit });
        return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
      },
      eventQueryFn: async (limit, eventType) => {
        const events = await runtime.events.query({
          motebit_id: runtime.motebitId,
          limit,
          event_types: eventType ? [eventType as EventType] : undefined,
        });
        return events.map((e) => ({
          event_type: e.event_type,
          timestamp: e.timestamp,
          payload: e.payload,
        }));
      },
      reflectFn: () => runtime.reflect(),
      rewriteMemoryDeps: {
        resolveNodeId: (shortIdOrUuid) => runtime.memory.resolveNodeIdPrefix(shortIdOrUuid),
        supersedeMemory: (nodeId, newContent, reason) =>
          runtime.memory.supersedeMemoryByNodeId(nodeId, newContent, reason),
      },
      conversationSearchFn: (query, limit) => runtime.searchConversations(query, limit),
    });

    // Interior tier of the answer engine — BM25 over committed motebit docs.
    // Web-only: the self-knowledge corpus is surface-specific.
    registry.register(
      recallSelfDefinition,
      createRecallSelfHandler((query, limit) =>
        Promise.resolve(
          querySelfKnowledge(query, { limit }).map((h) => ({
            source: h.source,
            title: h.title,
            content: h.content,
            score: h.score,
          })),
        ),
      ),
    );

    // Cloud-browser `computer` tool (virtual_browser embodiment).
    // Two auth paths: relay-mediated audience-bound tokens (production)
    // or legacy shared bearer (local-dev). Either OR both can be
    // configured; if neither, the tool is not registered (explicit-
    // not-configured beats silent-not-supported).
    //
    // Relay-mediated path (preferred, production-safe):
    //   1. Web app signs a grant token with the motebit's identity
    //      key (existing `createSyncToken` primitive, parameterized
    //      with `BROWSER_SANDBOX_GRANT_AUDIENCE`).
    //   2. Token-source POSTs grant to relay's
    //      `/api/v1/browser-sandbox/token`; receives a relay-signed
    //      sandbox token bound to `BROWSER_SANDBOX_AUDIENCE`.
    //   3. Browser-sandbox verifies signature against pinned relay
    //      pubkey. Single trust anchor, no bundled secret.
    //
    // Legacy path (`VITE_BROWSER_SANDBOX_TOKEN`): shared bearer in
    // the bundle. Acceptable for local-dev where the bundle is not
    // public. NEVER set on motebit.com's Vercel env — would expose
    // the bearer to anyone visiting the page.
    const env = (import.meta as unknown as Record<string, Record<string, string> | undefined>).env;
    const browserSandboxUrl = env?.VITE_BROWSER_SANDBOX_URL ?? "";
    const browserSandboxToken = env?.VITE_BROWSER_SANDBOX_TOKEN ?? "";
    const relayUrl = loadSyncUrl();

    let getAuthToken: (() => Promise<string> | string) | null = null;
    if (browserSandboxToken) {
      // Local-dev / single-tenant deployment path. The bundled token
      // matches the sandbox's `MOTEBIT_API_TOKEN` legacy bearer. The
      // sandbox's `dualAuth` accepts this OR a relay-signed token,
      // so the same sandbox deployment can serve both paths during
      // the transition window.
      getAuthToken = (): string => browserSandboxToken;
    } else if (relayUrl != null && relayUrl !== "") {
      // Production / federation-grade path. The grant signer is the
      // existing `createSyncToken` primitive — already audience-
      // parameterized, already routes through suite-dispatch, secure-
      // erases the private key after signing. No new crypto here.
      getAuthToken = createRelayBackedSandboxTokenSource({
        relayUrl,
        getGrantToken: async (): Promise<string> => {
          const grant = await this.createSyncToken(BROWSER_SANDBOX_GRANT_AUDIENCE);
          if (grant === null) {
            throw new Error("cannot mint browser-sandbox grant — motebit identity key unavailable");
          }
          return grant;
        },
      });
    }

    if (browserSandboxUrl && getAuthToken !== null) {
      this.computerRegistration = registerWebComputerTool(registry, {
        baseUrl: browserSandboxUrl,
        getAuthToken,
        motebitId: runtime.motebitId,
        approvalFlow: createWebComputerApprovalFlow(),
        events: runtime.events,
        // v1.5 — wire the runtime's signing path so closeSession also
        // emits a signed `ComputerSessionSummarized` receipt. Sibling
        // of the desktop wiring in apps/desktop/src/index.ts. The
        // runtime owns the signing keys; the registration owns the
        // session manager and audit-event sink.
        signSessionReceipt: (body) => runtime.signComputerSessionReceiptBody(body),
        hashSessionActions: (actions) => runtime.hashComputerSessionActions(actions),
        // v1.5 detach — emerge the signed receipt in the scene as a
        // verifiable artifact (sibling of the delegation receipt
        // bubble in chat.ts). The card runs Ed25519 verify locally;
        // user can dismiss via the close button.
        onSessionReceiptSigned: (receipt) => this.emergeSessionReceipt(receipt),
        // v1.3 — live screencast wiring. Bus is constructed once on
        // the WebApp; computer-tool starts the dispatcher's
        // openScreencast right after openSession and pipes frames
        // here. The `live_browser` shell is mounted ONCE at boot
        // (see `mountLiveBrowserShell` below); `onSessionLive`
        // attaches a session to the existing shell and `onSessionEnding`
        // detaches it. The shell itself never dissolves on session
        // boundaries — that's the intent-gated-slab principle:
        // the embodiment shell precedes content, sessions populate it.
        screencastBus: this.screencastBus,
        onSessionLive: (sessionId) => this.attachSessionToLiveBrowser(sessionId),
        onSessionEnding: () => {
          // chrome-1a-fix — clear tracked URL on session close so a
          // stale URL from a prior session doesn't leak into the
          // next `[Now]` block before the new session navigates.
          this._currentBrowserUrl = null;
          this.detachSessionFromLiveBrowser();
          // URL went to null → home register re-applies; body
          // transitions back to the slab home view (if affordances
          // exist) or the empty-empty fallback.
          this.applyHomeRegisterToCurrentState();
        },
        // chrome-1a-fix / prompt-1 — capture resolved URL on every
        // motebit-driven `computer({ kind: "navigate" })`. Sibling
        // of the user-driven capture path inside
        // `liveBrowserForwardEvent` below.
        onNavigateResult: (url) => {
          this._currentBrowserUrl = url;
          // Re-render chrome so the URL bar reflects the new URL.
          // Browser convention: address bar updates on every
          // navigation, not just on control-state change.
          this.applyChromeToCurrentState();
          // URL state changed → re-derive the home register. Real
          // URL → home view hides, screencast frame routing resumes.
          this.applyHomeRegisterToCurrentState();
        },
        // Implicit-grant fast path — let `request_control` skip the
        // slab-band prompt when the AI's reach for `computer` came
        // from a user-typed turn. Reads the runtime's per-turn
        // typed-intent attestation (set in `sendMessageStreaming`
        // start, cleared in its `finally`); proactive paths
        // (`generateActivation`, idle-tick) never run through that
        // method, so this returns null during their tool calls and
        // the prompt band fires as before. Doctrine: `CLAUDE.md`
        // § UI — "do not confirm what the user can already see."
        getCurrentTypedIntent: () => runtime.currentTypedIntent(),
        // Phase 1+2 of the persistent user_data_dir arc — in-memory
        // cache backed by IndexedDB + WebCrypto AES-GCM encryption-
        // at-rest. Survives reaper, tab close, browser restart,
        // device restart. First read lazy-loads from disk; writes
        // update cache + fire-and-forget persistence. Per-motebit
        // record so identities don't share cookies. Phase 3 adds
        // the `/cookies grant` + `/cookies revoke` UI. Doctrine:
        // `docs/doctrine/runtime-invariants-over-prompt-rules.md`
        // applied to the cloud-browser surface.
        getInitialCookies: async () => {
          await this.ensureCookieStoreLoaded(runtime.motebitId);
          return this._persistedCookies;
        },
        onCookiesPersisted: (cookies) => {
          this.setPersistedCookies(cookies);
          // Fire-and-forget — a persistence error shouldn't break
          // dispose. The user just loses the accumulated trust for
          // the next session; cold-start on next open.
          void saveCookies(runtime.motebitId, cookies).catch(() => {
            // Swallowed: encrypted-cookie-store is itself fail-soft;
            // any error here is already logged at the store layer.
          });
        },
      });

      // Prompt-1 — wire the browser-session info provider so the
      // runtime can compose `[Now]` blocks for the AI's prompt.
      // The provider reads `liveBrowserHandle` (open iff handle
      // exists), the co-browse machine state, and the surface-
      // tracked current URL. Closes the runtime-state-
      // confabulation hallucination class — the AI reads truth
      // instead of inferring continuity from conversation memory.
      runtime.setBrowserSessionProvider(() => {
        const handle = this.liveBrowserHandle;
        const machine = this.computerRegistration?.coBrowseControl;
        if (!handle) {
          return { status: "closed" as const };
        }
        return {
          status: "open" as const,
          ...(this._currentBrowserUrl ? { url: this._currentBrowserUrl } : {}),
          control: machine?.getState(),
        };
      });
    }

    // v1.2b — wire the slab's two-finger-hold-on-plane gesture to the
    // session-manager halt primitive. Two trigger surfaces compose the
    // same fail-closed `user_preempted` boundary (spec §3.3): this
    // touch gesture on the slab itself, and the `/halt` slash command
    // (handled in `setupHaltResumeListeners` below). Doctrine:
    // motebit-computer.md §"The user's touch — supervised agency."
    this.renderer.setSlabHaltGestureHandler?.(() => {
      this.computerRegistration?.sessionManager.halt();
      // The slab self-marks `halted = true` when the gesture fires;
      // no need to call `setSlabHalted` here. Resume mirrors back
      // through `motebit:resume`.
    });
    this.setupHaltResumeListeners();
    this.setupCoBrowseListeners();

    // Bootstrap stops here. The slab + live_browser shell + cloud
    // session are NOT eagerly mounted — the body is the show, the
    // slab is a tool. Mounting is gated on intent: `/computer` slash
    // command, AI computer tool call, or other affordances all
    // route through `invokeComputer()`. "Always-already" means
    // instantiation has no cold-start cost when invoked, NOT that
    // the slab is always rendered. Doctrine: `intent-gated-slab.md`
    // §"Affirmative shape" — empty register is the slab's READY
    // state ONCE invoked, not the surface's default.
    //
    // Layer 1 enforcement: `invokeComputer` and `dismissComputer` live
    // only on `WebApp` (the subclass), not here. `this: UnbootedWebApp`
    // structurally cannot call them — any attempt is a compile error.
  }

  /**
   * Co-browse Slice 2b — subscribe to the control state machine and
   * push the surface-built band element through the slab's chrome
   * slot on each transition. Also wire document-level listeners for
   * `/grant`, `/deny`, `/reclaim` slash commands (sibling of
   * `setupHaltResumeListeners`).
   *
   * No-op when the cloud-browser tool isn't registered (no co-browse
   * to govern). Subscriber + listeners both register against the
   * SAME `coBrowseControl` machine — Slice 2c+ will lift this to a
   * map-per-session if concurrent sessions arrive.
   *
   * Surface determinism: slash-command handlers call
   * `coBrowseControl.{grantControl,denyControl,reclaimControl}`
   * directly. Failed transitions (`{ok: false, reason}`) surface as
   * console hints rather than chat messages — calm software; the
   * band re-renders on the NEXT successful transition, so a wrong-
   * party / invalid-from-state click is silently absorbed at the UI
   * (the user just sees the truth of the current state).
   */
  private setupCoBrowseListeners(): void {
    if (!this.computerRegistration) return;
    if (typeof document === "undefined") return;
    const machine = this.computerRegistration.coBrowseControl;

    // Slab band re-renders on each successful transition. Failed
    // transitions don't fire — the listener is correct by
    // construction.
    const unsubscribeBand = machine.subscribe(() => {
      // Slice 2f — the band's home is now the live_browser slab
      // item's controlBandSlot (above the address bar). Both the
      // band AND the address bar are state-aware chrome on the
      // browser surface; one applier covers both.
      this.applyChromeToCurrentState();
    });
    this.coBrowseDisposers.push(unsubscribeBand, () => {
      // Clear chrome on teardown. The live_browser handle may
      // already be gone; chrome-applier no-ops in that case.
      this.applyChromeToCurrentState();
    });

    // chrome-1c — animate the mark on every signed receipt. The
    // receipts bus fires once per successful + signed tool call;
    // each fire produces a tool-name-keyed Web-Animation pulse on
    // the current mark element. Closes the felt thesis line
    // "Motebit acts, I supervise" at sub-second granularity.
    //
    // Uses `subscribeToolActivity` (not `subscribeToolInvocations`)
    // because the activity bus carries the raw `args` field we
    // need to discriminate `computer({kind: "screenshot"})` from
    // `computer({kind: "click"})`. The receipt envelope only
    // carries `args_hash` — the right fan-out for chrome-1c is the
    // bus that has the args. The activity bus fires at the same
    // moment as the receipt bus, so the visual feedback is
    // semantically equivalent: every act that signs also pulses.
    const unsubscribeReceiptAnim = this.subscribeToolActivity((event) => {
      // Find the live mark element. The chrome strip is rebuilt on
      // every state transition; the mark element is always reachable
      // via the standard class selector. Robust against null when
      // the strip hasn't mounted yet (early-init race).
      const mark = document.querySelector(".cobrowse-chrome-mark");
      if (!mark) return;
      animateMarkForReceipt(mark, event.tool_name, event.args);
    });
    this.coBrowseDisposers.push(unsubscribeReceiptAnim);

    // Slash-command surface — `/grant`, `/deny`, `/reclaim` dispatch
    // CustomEvents (sibling of `motebit:halt` / `motebit:resume`).
    // Direct typed-capability calls; check-affordance-routing
    // approves by construction.
    const onGrant = (): void => {
      machine.grantControl("user");
    };
    const onDeny = (): void => {
      machine.denyControl("user");
    };
    const onReclaim = (): void => {
      machine.reclaimControl();
    };
    // `/wheel` — the agent-surface pivot's mode-flip mechanism. The
    // user takes the wheel from motebit's default-driving register.
    // Wire-wise identical to `reclaimControl()` (motebit → user is
    // the same protocol-level transition regardless of which slash
    // command surfaced it); the rename names the user's mental model
    // in the new register's vocabulary instead of the cobrowser-
    // default's "I'm reclaiming something that was mine."
    //
    // Critical: a mode-flip is meaningless without surfacing the
    // affordance that the flip just unlocked — the editable URL
    // input. Without the focus dispatch, users `/wheel` into
    // cobrowse mode and find nothing actually editable; that's the
    // half-affordance gotcha. The flip is the precondition; the
    // focus is the completion. Both fire in the same gesture.
    //
    // Order is load-bearing. `reclaimControl()` synchronously calls
    // the chrome's subscriber, which rebuilds the strip and mounts
    // the new URL input element. By the time the call returns, the
    // element is reachable via the standard class selector. Focus
    // happens AFTER the rebuild — selecting end of value rather
    // than select-all so the user can type to append or backspace
    // to edit, not erase by typing. The existing focus listener
    // (in cobrowse-chrome.ts) surfaces the home overlay; that's
    // the calm-default "tell me where" prompt this gesture composes
    // naturally with.
    //
    // Fail-soft: if the transition rejected (e.g., already in user
    // state — `invalid_from_state`) the focus dispatch still fires.
    // Surfacing the input on a no-op transition is harmless and
    // preserves the user's mental model that `/wheel` "puts them in
    // the driver's seat" regardless of whether they were already
    // there.
    const onWheel = (): void => {
      machine.reclaimControl();
      const input = document.querySelector<HTMLInputElement>(".cobrowse-chrome-url-input");
      if (input) {
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    };
    // `/back` (and "motebit waiting" chip-tap) — cobrowse-as-mode
    // reshape's exit affordance. Symmetric partner to `/wheel`;
    // routes to the protocol-level `yieldControl` transition (user
    // → motebit). The new register's lifecycle from the user's
    // perspective: `/wheel` enters cobrowse mode + URL bar focuses;
    // user does their thing; `/back` exits cobrowse mode + motebit
    // resumes the narration register naturally. Surface-determinism
    // preserved (typed CustomEvent → typed-capability call). Doctrine:
    // chrome-as-state-render.md § "user register — cobrowse mode
    // entered."
    const onBack = (): void => {
      machine.yieldControl("user");
    };
    document.addEventListener("motebit:cobrowse-grant", onGrant);
    document.addEventListener("motebit:cobrowse-deny", onDeny);
    document.addEventListener("motebit:cobrowse-reclaim", onReclaim);
    document.addEventListener("motebit:cobrowse-wheel", onWheel);
    document.addEventListener("motebit:cobrowse-back", onBack);
    this.coBrowseDisposers.push(
      () => document.removeEventListener("motebit:cobrowse-grant", onGrant),
      () => document.removeEventListener("motebit:cobrowse-deny", onDeny),
      () => document.removeEventListener("motebit:cobrowse-reclaim", onReclaim),
      () => document.removeEventListener("motebit:cobrowse-wheel", onWheel),
      () => document.removeEventListener("motebit:cobrowse-back", onBack),
    );
  }

  /**
   * Disposers for the `motebit:halt` / `motebit:resume` document-level
   * listeners. Cleared in `stop()` so a teardown leaves no live event
   * listeners pointing at a destroyed renderer. Sibling of
   * `DesktopApp.haltResumeListeners`.
   */
  private haltResumeListeners: Array<() => void> = [];

  /**
   * Subscribe to `motebit:halt` / `motebit:resume` custom events
   * dispatched by the slash-command surface (`/halt`, `/resume`).
   * Centralizes the keyboard-trigger path so the same call sequence
   * (sessionManager.halt + adapter.setSlabHalted) lands no matter
   * which surface fired the trigger. No-op when `document` is
   * undefined (Node test envs); the production path always has it.
   */
  private setupHaltResumeListeners(): void {
    if (typeof document === "undefined") return;
    const onHalt = (): void => {
      this.computerRegistration?.sessionManager.halt();
      this.renderer.setSlabHalted?.(true);
    };
    const onResume = (): void => {
      this.computerRegistration?.sessionManager.resume();
      this.renderer.setSlabHalted?.(false);
    };
    document.addEventListener("motebit:halt", onHalt);
    document.addEventListener("motebit:resume", onResume);
    this.haltResumeListeners.push(
      () => document.removeEventListener("motebit:halt", onHalt),
      () => document.removeEventListener("motebit:resume", onResume),
    );
  }

  stop(): void {
    this.cursorPresence.stop();
    if (this.cuesTickInterval != null) {
      clearInterval(this.cuesTickInterval);
      this.cuesTickInterval = null;
    }
    if (this.housekeepingInterval != null) {
      clearInterval(this.housekeepingInterval);
      this.housekeepingInterval = null;
    }
    if (this.slabBridgeUnsub) {
      this.slabBridgeUnsub();
      this.slabBridgeUnsub = null;
    }
    while (this.haltResumeListeners.length > 0) {
      const dispose = this.haltResumeListeners.pop();
      dispose?.();
    }
    while (this.coBrowseDisposers.length > 0) {
      const dispose = this.coBrowseDisposers.pop();
      dispose?.();
    }
    // Tear down the cloud-browser session (if any) BEFORE the runtime
    // stops — the dispose path emits a `ComputerSessionClosed` event
    // that needs a live runtime.events sink to land in the audit log.
    if (this.computerRegistration) {
      void this.computerRegistration.dispose();
      this.computerRegistration = null;
    }
    // Stop the goals daemon's tick loop and tear down its subscription +
    // the controller's listeners (previously leaked — the runner was never
    // stopped on app teardown).
    this._scheduler?.dispose();
    this._goalsController?.dispose();
    this.runtime?.stop();
    this.renderer.dispose();
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  renderFrame(deltaTime: number, time: number): void {
    if (this.runtime) {
      this.runtime.renderFrame(deltaTime, time);
    } else {
      // Pre-bootstrap: render with idle cues
      this.renderer.render({
        cues: this.idleCues,
        delta_time: deltaTime,
        time,
      });
    }
  }

  // === Provider Management ===

  get isProviderConnected(): boolean {
    return this.runtime?.isAIReady ?? false;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.runtime?.currentModel ?? null;
  }

  connectProvider(config: ProviderConfig): void {
    const provider = createProvider(config, {
      // PR 4b — consumer-side mirror of the proxy's
      // X-Motebit-Routing-Reason header. The proxy emits it on every
      // motebit-cloud response with a routing decision; the provider's
      // AnthropicProvider reads the header and fires this callback.
      // Web threads the reason into the slab chrome via the same
      // `_routingNarration` slot BYOK + on-device already write to —
      // chip parity across all three tiers.
      onRoutingReason: (reason) => {
        this._routingNarration = reason;
        this.applyChromeToCurrentState();
      },
      // On-device engine had to run inference on the main thread (no worker on
      // this browser) — that hard-freezes the page during a turn. Surface it on
      // the DOM event bus so the UI layer can warn the owner honestly; fired
      // once, lazily, on the first turn that takes the fallback.
      onMainThreadFallback: () => {
        document.dispatchEvent(new CustomEvent("motebit:webllm-mainthread-fallback"));
      },
    }) as StreamingProvider;
    this._currentProvider = provider;
    // BYOK auto-router opt-in (per-turn `dispatchByokRouting` consumer
    // site). Captured on every connectProvider so a config swap from
    // BYOK→cloud / autoRoute-off cleanly clears the state.
    if (config.mode === "byok" && config.autoRoute === true) {
      this._byokAutoRouteVendor = config.vendor;
    } else {
      this._byokAutoRouteVendor = null;
    }
    // PR 4 — clear any stale routing chip when the provider config
    // changes. A BYOK→cloud swap, for example, would otherwise leave
    // the chip showing the last BYOK fire's chosen model even though
    // the next turn routes through the proxy. PR 4b (this commit)
    // closes the cloud-side gap: subsequent cloud turns surface the
    // chosen model via `onRoutingReason` above.
    this._routingNarration = null;
    if (this.runtime) {
      this.runtime.setProvider(provider);
    }
  }

  setProviderDirect(provider: StreamingProvider): void {
    this._currentProvider = provider;
    // Direct-set bypass — caller supplied a custom provider class, no
    // ProviderConfig in hand. Disable BYOK auto-routing since we can't
    // tell what the provider is configured for; the caller composes
    // their own routing if they want it.
    this._byokAutoRouteVendor = null;
    if (this.runtime) {
      this.runtime.setProvider(provider);
    }

    // The mind bit flipped while the slab rests on home → re-derive the
    // seed (ingress copy moves go_only → ask_or_go; the connect-a-mind
    // chip recedes). Same trigger discipline as setSyncStatus.
    if (this._onHomeRegister || this._homeOverlayActive) {
      this.mountHomeViewIntoBodySlot();
    }
  }
  disconnectProvider(): void {
    // No direct "unset provider" on runtime — reconnect with a different one
  }

  // === Appearance ===

  setInteriorColor(presetName: string): void {
    const preset = COLOR_PRESETS[presetName];
    if (!preset) return;
    this._interiorColor = preset;
    this.renderer.setInteriorColor(preset);
    // The chrome's lead mark is the creature's tiny mirror — its
    // gradient reads from `_interiorColor`. Without this refresh,
    // the creature recolors but the mark stays at the prior tint
    // until the next control-state transition. Sibling pattern to
    // /sensitivity + /vision mutations (slash-commands.ts L434,
    // 478, 488), which all call refreshSlabChrome after touching
    // runtime state the chrome reads.
    this.refreshSlabChrome();
  }

  setInteriorColorDirect(color: InteriorColor): void {
    this._interiorColor = color;
    this.renderer.setInteriorColor(color);
    // Mirror of setInteriorColor — see comment there. Custom-color
    // path (color picker swatch live preview) needs the same
    // refresh so the mark tracks the picker in real time.
    this.refreshSlabChrome();
  }

  getInteriorColor(): InteriorColor | null {
    return this._interiorColor;
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.renderer.setAudioReactivity(energy);
  }

  setLightEnvironment(): void {
    this.renderer.setLightEnvironment();
  }

  setDarkEnvironment(): void {
    this.renderer.setDarkEnvironment();
  }

  // === Identity File (motebit.md) ===
  //
  // Generate a signed motebit.md identity file from the in-browser
  // keypair + persisted governance config. Mirrors desktop's
  // IdentityManager.exportIdentityFile but reads governance from
  // localStorage (web) instead of Tauri config (desktop). Browser-safe:
  // @motebit/identity-file's generate() chains through @motebit/encryption
  // (zero node:* deps).

  async exportMotebitMd(): Promise<string | null> {
    if (!this._motebitId || !this._publicKeyHex) return null;
    const privKeyHex = await this.keyStore.loadPrivateKey();
    if (privKeyHex == null || privKeyHex === "") return null;

    const { generate: generateIdentityFile } = await import("@motebit/identity-file");
    const govModule = await import("./storage.js");
    const govConfig = govModule.loadGovernanceConfig();

    const RISK_NAMES = ["R0_READ", "R1_DRAFT", "R2_WRITE", "R3_EXECUTE", "R4_MONEY"];
    const presetKey = govConfig?.approvalPreset ?? "balanced";
    const presetGov = APPROVAL_PRESET_CONFIGS[presetKey] ?? APPROVAL_PRESET_CONFIGS.balanced!;
    const governance = {
      trust_mode: (presetKey === "autonomous" ? "full" : "guarded") as
        | "full"
        | "guarded"
        | "minimal",
      max_risk_auto: RISK_NAMES[presetGov.requireApprovalAbove]!,
      require_approval_above: RISK_NAMES[presetGov.requireApprovalAbove]!,
      deny_above: RISK_NAMES[presetGov.denyAbove]!,
      operator_mode: this.isOperatorMode,
    };
    const memory = {
      confidence_threshold: govConfig?.persistenceThreshold ?? 0.5,
      half_life_days: 7,
      per_turn_limit: govConfig?.maxMemoriesPerTurn ?? 5,
    };
    const devices = [
      {
        device_id: this._deviceId,
        name: "Web",
        public_key: this._publicKeyHex,
        registered_at: new Date().toISOString(),
      },
    ];

    const privKeyBytes = hexToBytes(privKeyHex);
    try {
      return await generateIdentityFile(
        {
          motebitId: this._motebitId,
          ownerId: this._motebitId,
          publicKeyHex: this._publicKeyHex,
          governance,
          memory,
          devices,
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }

  async verifyMotebitMd(content: string): Promise<{ valid: boolean; error?: string }> {
    const { verify: verifyIdentity } = await import("@motebit/identity-file");
    const result = await verifyIdentity(content, { expectedType: "identity" });
    const error = result.errors?.[0]?.message;
    return error !== undefined ? { valid: result.valid, error } : { valid: result.valid };
  }

  // Parse + verify a motebit.md and return the flat metadata the Restore
  // UI consumes (motebit_id, bornAt, public key, devices, governance,
  // memory). Pure read — no state mutation. The .md is structurally
  // public; the private key still has to come from a separate recovery
  // seed paste before any restore can proceed.
  async importMotebitMd(
    content: string,
  ): Promise<import("@motebit/identity-file").ImportIdentityResult> {
    const { importIdentityFile } = await import("@motebit/identity-file");
    return importIdentityFile(content);
  }

  // Side-effecting restore: materialize an imported identity onto this
  // device. Writes the new private key to the keystore, motebit_id +
  // device_id + public_key to localStorage (web's configStore). The
  // caller (Restore UI) reloads the page on `needsReload: true`; the
  // next bootstrap reads the new keystore + config and brings up the
  // runtime under the restored identity.
  //
  // When `preserveMemories=true`, the four memory-shaped IDB stores
  // (conversations / memory_nodes / plans / agent_trust) are re-keyed
  // from the old motebit_id to the new BEFORE the config write. The
  // signed-trail stores (events / audit_log / issued_credentials) are
  // intentionally orphaned so the cryptographic chain to the old
  // identity stays honest about authorship. See
  // `docs/doctrine/identity-restore.md` § "The keystore-probe
  // relationship" + `migrate-motebit-id.ts` in
  // `@motebit/browser-persistence` for the doctrinal split.
  async restoreIdentity(
    request: import("@motebit/identity-file").RestoreIdentityRequest,
  ): Promise<import("@motebit/identity-file").RestoreIdentityResult> {
    const { validateRestoreRequest } = await import("@motebit/identity-file");
    const failureReason = await validateRestoreRequest(request);
    if (failureReason !== null) {
      return { ok: false, reason: failureReason };
    }

    if (request.preserveMemories) {
      const oldMotebitId = localStorage.getItem("motebit:motebit_id");
      if (oldMotebitId !== null && oldMotebitId !== "") {
        try {
          await migrateMotebitId(oldMotebitId, request.metadata.motebitId);
        } catch {
          return { ok: false, reason: "memory_migration_failed" };
        }
      }
    }

    // Pre-write the IdentityCreated event with the historical bornAt
    // so the next bootstrap's "loaded" path returns the original
    // creation timestamp instead of fabricating Date.now(). The
    // Identity tab's "Born" display reads from this event. Failure
    // here is non-fatal (the rest of the restore still proceeds);
    // bootstrap will fall back to its auto-recover path with a
    // Date.now() event — born-date fidelity is lost in that case but
    // the identity is still recoverable.
    if (this._localEventStore !== null && this._identityStorage !== null) {
      const bornAtMs = Date.parse(request.metadata.bornAt);
      if (Number.isFinite(bornAtMs)) {
        try {
          await writeRestoredIdentity({
            identityStorage: this._identityStorage,
            eventStoreAdapter: this._localEventStore,
            motebitId: request.metadata.motebitId,
            ownerId: "Web",
            bornAtMs,
          });
        } catch {
          // Best-effort. The user's identity restore still proceeds;
          // bootstrap's auto-recover path fires Date.now() event on
          // next launch — Born displays as "today" until the user
          // exports + reimports a fresh motebit.md.
        }
      }
    }

    const newDeviceId = crypto.randomUUID();
    try {
      await this.keyStore.storePrivateKey(request.privateKeyHex);
    } catch {
      return { ok: false, reason: "keystore_write_failed" };
    }
    try {
      localStorage.setItem("motebit:motebit_id", request.metadata.motebitId);
      localStorage.setItem("motebit:device_id", newDeviceId);
      localStorage.setItem("motebit:device_public_key", request.metadata.publicKey);
    } catch {
      return { ok: false, reason: "config_write_failed" };
    }
    return { ok: true, motebitId: request.metadata.motebitId, needsReload: true };
  }

  // === Operator Mode ===
  //
  // PIN-protected escalation that allows high-risk tools (write, execute,
  // payments). The runtime wires the LocalStorageKeyringAdapter as its
  // PIN store; the operator.ts API in @motebit/runtime handles
  // PBKDF2-hashed PIN persistence + lockout-after-failed-attempts.

  get isOperatorMode(): boolean {
    return this.runtime?.isOperatorMode ?? false;
  }

  async setOperatorMode(
    enabled: boolean,
    pin?: string,
  ): Promise<{ success: boolean; needsSetup?: boolean; error?: string; lockedUntil?: number }> {
    if (!this.runtime) return { success: false, error: "Runtime not ready" };
    return this.runtime.setOperatorMode(enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    if (!this.runtime) throw new Error("Runtime not ready");
    return this.runtime.setupOperatorPin(pin);
  }

  async resetOperatorPin(): Promise<void> {
    if (!this.runtime) throw new Error("Runtime not ready");
    return this.runtime.resetOperatorPin();
  }

  // === Conversation ===

  get activeConversationId(): string | null {
    return this.runtime?.getConversationId() ?? null;
  }

  getConversationHistory(): ConversationMessage[] {
    return this.runtime?.getConversationHistory() ?? [];
  }

  resetConversation(): void {
    this.runtime?.resetConversation();
    this.clearArtifacts();
  }

  async loadConversationById(id: string): Promise<ConversationMessage[]> {
    if (!this.runtime) return [];
    // Preload messages from IDB into sync cache before loading
    if (this._convStore) await this._convStore.preloadConversation(id);
    this.runtime.loadConversation(id);
    return this.runtime.getConversationHistory();
  }

  async deleteConversation(id: string): Promise<void> {
    // Privacy-layer choke point: signed flush certs per message, one
    // DeleteRequested event, then in-memory state cleanup. Returns
    // void to the caller — the panel doesn't currently surface the
    // certs, but they're persisted in the audit log.
    await this.runtime?.deleteConversation(id);
  }

  listConversations(): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    return this.runtime?.listConversations() ?? [];
  }

  // === Streaming Chat ===

  async *sendMessageStreaming(
    text: string,
    runId?: string,
    options?: {
      delegationScope?: string;
      suppressHistory?: boolean;
      userActionAttestation?: import("@motebit/sdk").UserActionAttestation;
      /** See `MotebitRuntime.sendMessageStreaming` — goal fires
       *  thread this so the resting slab item is *legible* as the
       *  goal's artifact per `docs/doctrine/goal-results.md`. */
      goalContext?: { goal_id: string; goal_prompt: string };
    },
  ): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");
    if (this._isProcessing) throw new Error("Already processing");

    this._isProcessing = true;
    try {
      // PR 4 — clear any stale routing chip from a prior turn at
      // entry. The BYOK / on-device intercept below repopulates if
      // it dispatches; absence leaves the chip null (chrome reads
      // null → no chip). Calm-software default: the chip never
      // outlives its own turn.
      this._routingNarration = null;
      // BYOK auto-router consumer site (PR 2 of auto-routing arc).
      // Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
      // § "PR 2 — BYOK consumer". Per-turn: dispatch over the user's
      // vendor catalog → mutate the StreamingProvider's model →
      // forward to the runtime unchanged. No balance filter (BYOK
      // pays vendors directly); the dispatcher stays consumer-
      // neutral. Handles every `RoutingDecision.kind` value (`route`,
      // `fallback`, `deny`) per the contract enforced by
      // `check-routing-decision-coverage` (#95).
      if (this._byokAutoRouteVendor && this._currentProvider) {
        const decision = dispatchByokRouting(text, this._byokAutoRouteVendor);
        switch (decision.kind) {
          case "route": {
            this._currentProvider.setModel?.(decision.model);
            break;
          }
          case "fallback": {
            // Policy preference wasn't in this vendor's catalog;
            // honor the backup the dispatcher picked from the
            // vendor's catalog ordering (which is the consumer's
            // preference signal per the dispatcher contract).
            this._currentProvider.setModel?.(decision.backup);
            break;
          }
          case "deny": {
            // Constraints filtered every catalog entry — leave the
            // provider on its currently-set model (the user's
            // configured default). Calm-software fallback.
            break;
          }
        }
        // PR 4 — surface the chosen model in the slab chrome's
        // routing-narration channel. `formatRoutingChip` returns
        // null on `deny` (consistent calm-default — no chip when
        // no routing happened); the chrome's optional
        // `routingNarration` reads this on the next
        // `applyChromeToCurrentState`.
        this._routingNarration = formatRoutingChip(decision);
        this.applyChromeToCurrentState();
      }
      yield* this.runtime.sendMessageStreaming(text, runId, options);
    } finally {
      this._isProcessing = false;
    }
  }

  /**
   * Deterministic surface-affordance → delegation. The chip, slash command,
   * or scene click routes through this, never through `sendMessageStreaming`
   * with a constructed prompt — see `docs/doctrine/surface-determinism.md`
   * and the `check-affordance-routing` gate.
   *
   * Unlike `sendMessageStreaming`, does NOT require an AI provider: the chip
   * path is purely runtime → relay → agent. Callable offline-with-relay.
   */
  async *invokeCapability(
    capability: string,
    prompt: string,
    options?: { signal?: AbortSignal; acknowledgeNoHistoryRisk?: boolean; targetWorkerId?: string },
  ): AsyncGenerator<StreamChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (this._isProcessing) throw new Error("Already processing");

    this._isProcessing = true;
    try {
      // Cold-start opt-in: a paid delegation to a NEW worker (no trust history)
      // proceeds P2P only when the user has consciously opted in (Settings →
      // Governance → "Pay new agents directly"). Read fresh per call so the
      // toggle takes effect live. Default off → an ineligible cold-start pair
      // safely degrades to relay-mode (the pre-flight blocks the broadcast, so
      // no funds move). An explicit option overrides the stored preference.
      const acknowledgeNoHistoryRisk = options?.acknowledgeNoHistoryRisk ?? loadColdStartOptIn();
      yield* this.runtime.invokeCapability(capability, prompt, {
        ...options,
        ...(acknowledgeNoHistoryRisk ? { acknowledgeNoHistoryRisk: true } : {}),
      });
    } finally {
      this._isProcessing = false;
    }
  }

  // === Tool-invocation bus ===

  /**
   * Subscribe to signed `ToolInvocationReceipt`s as the runtime emits
   * them. Returns an unsubscribe thunk. Consumers: panels, devtools,
   * telemetry, future audit UIs — all can join the same stream
   * without stepping on each other.
   *
   * Fires once per matched tool_call calling→done pair, after the
   * runtime has composed and signed the receipt. Listener faults are
   * isolated at the runtime wire-up site — a thrown exception from one
   * subscriber does not prevent others from receiving the same receipt.
   */
  subscribeToolInvocations(
    listener: (receipt: import("@motebit/crypto").SignableToolInvocationReceipt) => void,
  ): () => void {
    this._toolInvocationListeners.add(listener);
    return () => {
      this._toolInvocationListeners.delete(listener);
    };
  }

  /**
   * Subscribe to the ephemeral tool-activity stream — the raw args +
   * result bytes the receipt's hashes commit to. Fires at the same
   * moment as `subscribeToolInvocations`, so consumers that need both
   * (e.g. slab-item projection reads `event.args` + `event.result`
   * to paint live content onto the plane) receive them in lockstep.
   *
   * Contract: subscribers must not retain the payload across calls.
   * Activity is for live rendering, not persistence — the signed
   * receipt is the audit artifact.
   */
  subscribeToolActivity(
    listener: (event: import("@motebit/runtime").ToolActivityEvent) => void,
  ): () => void {
    this._toolActivityListeners.add(listener);
    return () => {
      this._toolActivityListeners.delete(listener);
    };
  }

  /**
   * Expose the render adapter so surface modules that need to drive
   * scene primitives directly (slab, artifact manager) can reach
   * them without holding a reference through every seam. Returns
   * the concrete `ThreeJSAdapter` the web app instantiates.
   */
  getRenderer(): ThreeJSAdapter {
    return this.renderer;
  }

  /**
   * Access to the goals controller — the Goals panel reads list state +
   * runs CRUD through this, uniform with desktop / mobile. Null if
   * bootstrap hasn't finished yet.
   */
  getGoalsController(): GoalsController | null {
    return this._goalsController;
  }

  /**
   * Access to the in-process goals engine (web's daemon). The panel
   * reaches this only for the web-daemon-only concerns the projection
   * controller doesn't carry: run records (the "running" pulse) and the
   * once-goal `runNow(onChunk)` live-progress path. Null pre-bootstrap.
   */
  getGoalsScheduler(): GoalsEngine | null {
    return this._scheduler;
  }

  /**
   * Deterministic path for surface affordances to fire a local tool.
   * `invocation_origin: "user-tap"` in the signed audit trail
   * discriminates user-driven from model-driven calls. The activity
   * bus + receipt bus fan out as usual, so subscribers (slab, panels)
   * update from the same pipeline the AI loop's tool calls use.
   */
  async invokeLocalTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<import("@motebit/sdk").ToolResult> {
    if (!this.runtime) {
      return { ok: false, error: "runtime not initialized" };
    }
    return this.runtime.invokeLocalTool(name, args);
  }

  // === Approval Flow ===

  get hasPendingApproval(): boolean {
    return this.runtime?.hasPendingApproval ?? false;
  }

  get pendingApprovalInfo(): { toolName: string; args: Record<string, unknown> } | null {
    return this.runtime?.pendingApprovalInfo ?? null;
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.resumeAfterApproval(approved);
  }

  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    if (!this.runtime) return;
    yield* this.runtime.resolveApprovalVote(approved, approverId);
  }

  // === Sovereign Features ===

  async summarize(): Promise<string | null> {
    return this.runtime?.summarizeCurrentConversation() ?? null;
  }

  async housekeeping(): Promise<void> {
    await this.runtime?.consolidationCycle();
  }

  async exportData(): Promise<string> {
    const runtime = this.runtime;
    const identity = {
      motebitId: this._motebitId,
      deviceId: this._deviceId,
      publicKeyHex: this._publicKeyHex,
    };
    const memories = runtime ? await runtime.memory.exportAll() : { nodes: [], edges: [] };
    const conversations = runtime ? runtime.listConversations() : [];
    const credentials = runtime ? runtime.getIssuedCredentials() : [];
    const gradient = runtime ? runtime.getGradient() : null;

    return JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        identity,
        memories: {
          nodes: memories.nodes.filter(
            (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > Date.now()),
          ),
          edges: memories.edges,
        },
        conversations,
        credentials,
        gradient,
      },
      null,
      2,
    );
  }

  getRuntime(): MotebitRuntime | null {
    return this.runtime;
  }

  /**
   * The IDB-backed skills registry. Null until bootstrap() finishes (or
   * if the IDB open failed). The panel UI calls this and renders an
   * "unavailable" state when null — same shape as desktop's
   * `sidecar_unavailable` typed failure path.
   */
  getSkillRegistry(): SkillRegistry | null {
    return this._skillRegistry;
  }

  /**
   * The IDB-backed skill audit sink. Null in lockstep with
   * `getSkillRegistry()` — same IDB handle, same failure mode. The
   * panel passes this to its `RegistryBackedSkillsPanelAdapter` so
   * the adapter-emitted `skill_consent_granted` events land in the
   * same stream as the registry-emitted trust/remove events.
   */
  getSkillAuditSink(): IdbSkillAuditSink | null {
    return this._skillAuditSink;
  }

  /**
   * Reveal the Ed25519 private seed for backup. Returns the 64-char hex
   * string from the encrypted keystore. The caller (settings UI) is
   * responsible for the user-facing protection: explicit click,
   * blur-on-display, copy + auto-hide. The keystore itself decrypts via
   * the browser-held WebCrypto key — the same path the runtime uses at
   * boot to load identity for signing.
   */
  async revealRecoverySeed(): Promise<string | null> {
    return this.keyStore.loadPrivateKey();
  }

  get motebitId(): string {
    return this._motebitId;
  }

  /**
   * The orphaned motebit_id when bootstrap detected divergent state on
   * launch — or `null` on the clean-bootstrap path. Surfaces UI reads
   * this to show the recovery banner with restore CTAs; callable any
   * time after `bootstrap()` resolves.
   */
  get divergedFromMotebitId(): string | null {
    return this._divergedFromMotebitId;
  }

  /**
   * Clear the divergence notice (called when the user dismisses the
   * banner or completes a restore). Subsequent calls to
   * `divergedFromMotebitId` return `null`; the field is only set once at
   * bootstrap, so clearing here means "the user has acknowledged the
   * orphaned identity".
   */
  clearDivergenceNotice(): void {
    this._divergedFromMotebitId = null;
  }

  /**
   * Locally-known goal execution rows — the Sovereign Ledger's
   * substrate-alive source of truth. Reads from the goals engine state
   * (the local source of scheduled goals + their fire timestamps),
   * filters to goals with execution history (terminal status OR
   * `last_run_at` set), and maps to the canonical `GoalRow` wire
   * shape. The controller merges this with relay-fetched goals; local
   * wins on goal_id collision because local is the signed-locally
   * truth, relay is a mirror.
   *
   * Future arc swaps this for per-fire signed ExecutionReceipt
   * aggregation via `replayGoal()` from packages/runtime/src/
   * execution-ledger.ts — each fire becomes a signature-verified row.
   * Contract-preserving swap (same `GoalRow` shape); only deepens the
   * source of truth. Doctrine: docs/doctrine/receipts-unified.md.
   */
  getLocalLedger(): Array<{
    goal_id: string;
    prompt: string;
    status: string;
    created_at: number;
  }> {
    const scheduler = this._scheduler;
    if (!scheduler) return [];
    const { goals } = scheduler.getState();
    return goals
      .filter((g) => g.last_run_at != null || g.status === "completed" || g.status === "failed")
      .map((g) => ({
        goal_id: g.goal_id,
        prompt: g.prompt,
        status: String(g.status),
        created_at: g.created_at ?? g.last_run_at ?? Date.now(),
      }));
  }

  /**
   * Query the local event store for this motebit's bootstrap
   * IdentityCreated event. Returns the locally-known identity snapshot
   * (motebit_id, created_at, current public key, owner_id) for the
   * Sovereign Identity tab to render without a relay round-trip. Returns
   * null when the event store is unavailable or no matching event exists.
   * Per protocol-primacy doctrine — Identity is local data; the relay is
   * a sync layer for cross-device succession, not the source of truth
   * for "who you are right now."
   */
  async getLocalIdentity(): Promise<{
    motebitId: string;
    createdAt: number;
    publicKeyHex: string;
    ownerId: string | null;
  } | null> {
    const store = this._localEventStore;
    if (!store || this._motebitId === "" || this._publicKeyHex === "") return null;
    try {
      const events = await store.query({
        motebit_id: this._motebitId,
        event_types: [EventType.IdentityCreated],
      });
      // First matching event is the bootstrap event (sorted by clock).
      const first = events.length > 0 ? events[0] : null;
      if (!first) return null;
      const payload = first.payload as { owner_id?: string } | null | undefined;
      return {
        motebitId: this._motebitId,
        createdAt: first.timestamp,
        publicKeyHex: this._publicKeyHex,
        ownerId: payload?.owner_id ?? null,
      };
    } catch {
      return null;
    }
  }

  get deviceId(): string {
    return this._deviceId;
  }

  get publicKeyHex(): string {
    return this._publicKeyHex;
  }

  // === Sovereign-funnel intake ===

  /**
   * Announce this motebit to the canonical relay's durable intake ledger — the
   * metabolic intake of the sovereign funnel. Fired silently on the first
   * network action (see {@link startSync}), never via a launch-time prompt: a
   * purely-local motebit that never touches the relay is never announced and
   * stays uncounted, and a benign "none"-sensitivity existence announcement is
   * not something to make the user decide. Calm software — no interstitial.
   *
   * Signs with the genesis key (on a sovereign mint the first device key IS the
   * genesis key, so the relay's id↔key binding check passes) and POSTs to
   * {@link DEFAULT_RELAY_URL}. Best-effort: returns a typed result, never
   * throws; marks the motebit announced only on confirmation, so callers can
   * gate on {@link isAnnounced} and a failed attempt retries on the next
   * network action.
   */
  async announceMotebit(): Promise<AnnounceMotebitResult> {
    if (!this._motebitId || !this._publicKeyHex) {
      return {
        status: "failed",
        code: "unknown",
        message: "Identity not bootstrapped",
      };
    }
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex == null || privateKeyHex === "") {
      return {
        status: "failed",
        code: "unknown",
        message: "No signing key available",
      };
    }
    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }
    const result = await announceMotebit({
      motebitId: this._motebitId,
      publicKey: this._publicKeyHex,
      privateKey: privKeyBytes,
      surface: "web",
      relayUrl: DEFAULT_RELAY_URL,
    });
    // Mark announced ONLY on a real relay-recorded announcement. A `skipped`
    // (legacy/unbound id) is terminal but NOT announced — left unmarked so a
    // later sovereign re-mint re-attempts; the preflight makes that cheap (no
    // network, no console 400) instead of a doomed round-trip every launch.
    if (result.status === "announced") markAnnounced();
    return result;
  }

  // === Key Rotation ===

  /**
   * Rotate the Ed25519 keypair: generate new keys, create a signed succession
   * record (old + new keys both sign), update encrypted IndexedDB keystore,
   * and submit to relay if syncing.
   */
  async rotateKey(reason?: string): Promise<{ newPublicKey: string }> {
    // 1. Load existing private key from encrypted keystore
    const oldPrivKeyHex = await this.keyStore.loadPrivateKey();
    if (oldPrivKeyHex == null || oldPrivKeyHex === "") {
      throw new Error("No private key available — bootstrap first");
    }

    const oldPrivKeyBytes = new Uint8Array(oldPrivKeyHex.length / 2);
    for (let i = 0; i < oldPrivKeyHex.length; i += 2) {
      oldPrivKeyBytes[i / 2] = parseInt(oldPrivKeyHex.slice(i, i + 2), 16);
    }

    try {
      // 2. Derive old public key bytes from hex
      const oldPubHex = this._publicKeyHex;
      if (!oldPubHex) throw new Error("No public key available — bootstrap first");
      const oldPubKeyBytes = new Uint8Array(oldPubHex.length / 2);
      for (let i = 0; i < oldPubHex.length; i += 2) {
        oldPubKeyBytes[i / 2] = parseInt(oldPubHex.slice(i, i + 2), 16);
      }

      // 3. Rotate: generates new keypair + signed succession record
      const rotateResult = await rotateIdentityKeys({
        oldPrivateKey: oldPrivKeyBytes,
        oldPublicKey: oldPubKeyBytes,
        reason,
      });

      const newPubKeyHex = rotateResult.newPublicKeyHex;
      const newPrivKeyHex = bytesToHex(rotateResult.newPrivateKey);
      secureErase(rotateResult.newPrivateKey);

      // 4. Store new private key in encrypted IndexedDB
      await this.keyStore.storePrivateKey(newPrivKeyHex);

      // 5. Update public key in localStorage and in-memory
      localStorage.setItem("motebit:device_public_key", newPubKeyHex);
      this._publicKeyHex = newPubKeyHex;

      // 6. Submit to relay if syncing (best-effort)
      try {
        const token = await this.createSyncToken("device:auth");
        if (token != null) {
          const syncUrl = loadSyncUrl();
          if (syncUrl != null && syncUrl !== "") {
            await fetch(`${syncUrl}/api/v1/agents/${this._motebitId}/key-rotation`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                device_id: this._deviceId,
                new_public_key: newPubKeyHex,
                succession_record: rotateResult.successionRecord,
              }),
            });
          }
        }
      } catch {
        // Non-fatal — relay notification is best-effort
      }

      return { newPublicKey: newPubKeyHex };
    } finally {
      secureErase(oldPrivKeyBytes);
    }
  }

  // === MCP Management ===

  async addMcpServer(config: McpServerConfig): Promise<void> {
    if (config.transport !== "http") {
      throw new Error(
        "Web only supports HTTP MCP servers. Use the desktop or CLI app for stdio servers.",
      );
    }
    if (config.url == null || config.url === "") {
      throw new Error("HTTP MCP server requires a url");
    }

    // Attach advisory verifier: always accepts, revokes trust on manifest change
    config.serverVerifier = new AdvisoryManifestVerifier();
    const adapter = new McpClientAdapter(config);
    await adapter.connect();

    // Persist verifier-applied config updates
    config.toolManifestHash = adapter.serverConfig.toolManifestHash;
    config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
    if (adapter.serverConfig.trusted === false) {
      config.trusted = false;
    }

    // Persist motebit public key if newly pinned during connect
    if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
      const pinnedKey = adapter.serverConfig.motebitPublicKey;
      if (pinnedKey && !config.motebitPublicKey) {
        config.motebitPublicKey = pinnedKey;
      }
    }

    this.registerMcpTools(adapter, config);

    this.mcpAdapters.set(config.name, adapter);
    this._mcpServers = this._mcpServers.filter((s) => s.name !== config.name);
    this._mcpServers.push(config);
    this.persistMcpServers();
  }

  async removeMcpServer(name: string): Promise<void> {
    const adapter = this.mcpAdapters.get(name);
    if (adapter) {
      await adapter.disconnect();
      this.mcpAdapters.delete(name);
    }
    if (this.runtime) {
      this.runtime.unregisterExternalTools(`mcp:${name}`);
    }
    this._mcpServers = this._mcpServers.filter((s) => s.name !== name);
    this.persistMcpServers();
  }

  getMcpServers(): Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
  }> {
    return this._mcpServers.map((config) => {
      const adapter = this.mcpAdapters.get(config.name);
      return {
        name: config.name,
        url: config.url ?? "",
        connected: adapter?.isConnected ?? false,
        toolCount: adapter?.getTools().length ?? 0,
        trusted: config.trusted ?? false,
        motebit: config.motebit ?? false,
      };
    });
  }

  setMcpServerTrust(name: string, trusted: boolean): void {
    const config = this._mcpServers.find((s) => s.name === name);
    if (!config) return;
    config.trusted = trusted;

    const adapter = this.mcpAdapters.get(name);
    if (adapter && this.runtime) {
      this.runtime.unregisterExternalTools(`mcp:${name}`);
      this.registerMcpTools(adapter, config);
    }

    this.persistMcpServers();
  }

  private registerMcpTools(adapter: McpClientAdapter, config: McpServerConfig): void {
    const tempRegistry = new InMemoryToolRegistry();
    for (const mcpTool of adapter.getTools()) {
      const def = {
        name: mcpTool.name,
        description: `[${config.name}] ${mcpTool.description ?? mcpTool.name}`,
        inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
        ...(config.trusted === true ? {} : { requiresApproval: true as const }),
      };
      tempRegistry.register(def, (args: Record<string, unknown>) =>
        adapter.executeTool(mcpTool.name, args),
      );
    }
    if (this.runtime) {
      this.runtime.registerExternalTools(`mcp:${config.name}`, tempRegistry);
    }
  }

  private async reconnectMcpServers(): Promise<void> {
    const raw = localStorage.getItem("motebit:mcp_servers");
    if (raw == null || raw === "") return;
    try {
      const configs = JSON.parse(raw) as McpServerConfig[];
      this._mcpServers = configs;
      let changed = false;
      for (const config of configs) {
        try {
          config.serverVerifier = new AdvisoryManifestVerifier();
          const adapter = new McpClientAdapter(config);
          await adapter.connect();

          // Persist verifier-applied config updates
          config.toolManifestHash = adapter.serverConfig.toolManifestHash;
          config.pinnedToolNames = adapter.serverConfig.pinnedToolNames;
          if (adapter.serverConfig.trusted === false) {
            config.trusted = false;
          }

          if (adapter.isMotebit && adapter.verifiedIdentity?.verified) {
            const pinnedKey = adapter.serverConfig.motebitPublicKey;
            if (pinnedKey && !config.motebitPublicKey) {
              config.motebitPublicKey = pinnedKey;
            }
          }

          this.registerMcpTools(adapter, config);
          this.mcpAdapters.set(config.name, adapter);
          changed = true;
        } catch {
          // Non-fatal — server may be offline
        }
      }
      if (changed) {
        this.persistMcpServers();
      }
    } catch {
      // Non-fatal — corrupted localStorage
    }
  }

  private persistMcpServers(): void {
    localStorage.setItem("motebit:mcp_servers", JSON.stringify(this._mcpServers));
  }

  // === Spatial Canvas ===

  addArtifact(
    spec: import("@motebit/render-engine").ArtifactSpec,
  ): import("@motebit/render-engine").ArtifactHandle | undefined {
    return this.renderer.addArtifact?.(spec);
  }

  /**
   * v1.3 — open the `live_browser` slab item that subscribes to the
   * screencast bus. Idempotent: a second call without an intervening
   * dissolve is a no-op (the bus only publishes one stream at a
   * time).
   *
   * Slice 2c — bundles the input-forwarding wiring into the slab
   * item payload: `forwardUserInput` callback (drives runtime ->
   * dispatcher -> Chromium) plus the cloud viewport dimensions for
   * coordinate translation fallback. The slab-items renderer
   * extracts these and wires DOM capture onto the screencast img
   * via `attachInputCapture`. When the registration lacks a
   * session manager (registry not configured), the payload omits
   * forwarding and the slab is read-only — same shape as before.
   */
  /**
   * Mount the `live_browser` shell at WebApp boot. Called ONCE per
   * WebApp lifetime, right after the cloud-browser registration is
   * built. The shell carries:
   *
   *   - The screencast bus subscription (publishes frames once a
   *     session opens; the shell waits silently until then).
   *   - A stable session-aware forward-event closure that reads
   *     `_activeBrowserSessionId` lazily, so URL-bar typing works
   *     in every register (pre-session via lazy session-open,
   *     session-live via direct dispatch).
   *   - Default display dims (1280×800) — fallback for input-
   *     coordinate translation before the first frame's
   *     naturalWidth/Height take over.
   *   - The `onLiveBrowserMount` callback that captures the handle
   *     and applies chrome immediately, so the URL bar + breathing
   *     placeholder are visible at frame zero.
   *
   * The shell never dissolves on session boundaries; sessions
   * attach via `attachSessionToLiveBrowser` and detach via
   * `detachSessionFromLiveBrowser`. This is the intent-gated-slab
   * principle's deepest expression: empty IS READY because the
   * shell precedes content.
   */
  protected mountLiveBrowserShell(): void {
    if (this.liveBrowserItemId !== null) return;
    if (!this.runtime) return;
    // Headless guard — the shell is a DOM-rooted element. Sibling
    // pattern of `emergeSessionReceipt` and `removeArtifact`'s
    // typeof document checks; in a Node test environment there's no
    // document to mount into and the renderer is a no-op anyway.
    if (typeof document === "undefined") return;
    const id = WebApp.LIVE_BROWSER_SHELL_ID;
    this.liveBrowserItemId = id;
    const forwardUserInput = this.buildSessionAwareForwardEvent();
    this.liveBrowserForwardEvent = forwardUserInput;
    this.runtime.slab.openItem({
      id,
      kind: "live_browser",
      mode: "virtual_browser",
      payload: {
        frameSource: this.screencastBus,
        forwardUserInput,
        // Default dims — input-capture's fallback path uses these
        // before the first screencast frame's naturalWidth/Height
        // take over. Pre-frame clicks land on a hidden img with
        // zero rect, so these only ever matter as defensive
        // defaults.
        displayWidth: 1280,
        displayHeight: 800,
        // Soul-tinted local input-feedback layer — cursor halo,
        // click ripple, scroll indicator all share the creature's
        // current interior color so feedback reads as native to
        // the slab rather than a generic web hover state.
        soulTintHex: this._interiorColor ? this.tintToHex(this._interiorColor.tint) : undefined,
        onLiveBrowserMount: (h: LiveBrowserElementHandle) => {
          this.liveBrowserHandle = h;
          // Apply chrome immediately so the URL bar + control band
          // land in their proper slots at frame zero, not a tick
          // later. The shell's chrome reads the current control
          // state and the (possibly null) session URL — both
          // honest representations of the READY register.
          this.applyChromeToCurrentState();
          // Apply the home register — slab opens at URL null, so
          // the body slot is visible with the home view (affordance
          // tiles if past activity exists, empty-empty fallback if
          // not). Goes through the same applier the URL-change
          // path uses, single source of truth for the toggle.
          this.applyHomeRegisterToCurrentState();
        },
        // 2026-05-09 — route every pre-decoded frame onto the slab's
        // WebGL screen-mesh texture. Pixels live in the scene graph,
        // share depth with the creature, and clip to the meniscus
        // silhouette. The HTML img stays mounted (opacity:0) for
        // the existing input-capture pipeline — same screen-space
        // rect, zero visual contribution.
        //
        // Home-register gate: skip the texture upload when on the
        // home register. The cloud Chromium streams `about:blank`
        // white frames before any navigation; without this gate
        // they'd compete with the home view for the body. The
        // bus still flows (frames keep arriving so the first
        // post-navigation frame lands promptly) — we just don't
        // route to the texture while the home view is the body.
        onFrameDecoded: (image: HTMLImageElement | ImageBitmap) => {
          if (this._onHomeRegister) return;
          this.renderer.setSlabScreencastImage?.(image);
        },
      },
    });
  }

  /**
   * Attach a freshly-opened cloud session to the live_browser shell.
   * Called from `onSessionLive`. Mounts the shell first if it isn't
   * up yet (idempotent) so the AI computer-tool path also counts as
   * an invocation: when the AI calls `computer({...})`, the session
   * opens, this fires, and the shell materializes around it.
   */
  private attachSessionToLiveBrowser(sessionId: string): void {
    this.mountLiveBrowserShell();
    this._activeBrowserSessionId = sessionId;
    // Re-render chrome — the strip's URL bar may have been in the
    // pre-session ready register; with a live session it transitions
    // to the session-bound register (URL bar shows live URL, control
    // band shows live state).
    this.applyChromeToCurrentState();
    // Start keepalive — pings the sandbox every 60s so the idle
    // reaper doesn't tear down the session while the user has
    // motebit foregrounded but isn't actively interacting with the
    // cloud browser. Closes the "I cleared the CAPTCHA, idled 11
    // min, fresh CAPTCHA waiting" failure mode without making
    // sessions unboundedly long (closing the tab stops the timer;
    // normal reaper takes over after BROWSER_SANDBOX_IDLE_MS).
    this.startCloudSessionKeepalive();
  }

  /**
   * Slice 2f — apply BOTH the control band and the address bar to
   * the current co-browse control state. Both are state-aware chrome
   * mounted on the live_browser slab item; both clear when the state
   * doesn't ask for them.
   *
   * Chrome-1 — one unified strip mounted in `controlBandSlot` on
   * every state. The mark in the lead expresses control state; the
   * middle holds the URL input (user state) or a state caption
   * (handoff_pending / paused) or empty (motebit driving — page
   * below shows destination). The trail holds the contextual
   * affordance (take back / grant + deny / nav arrows / resume).
   *
   * `addressBarSlot` is always cleared — the unified strip absorbs
   * its content. The slot itself stays in render-engine for
   * compatibility; removing it cleanly is a follow-up slice.
   *
   * No live_browser handle = no chrome. If the handle isn't mounted,
   * there's no session to control — the slab's empty register (the
   * always-already breathing mark) is the doctrine-aligned visual,
   * not an off-slab control band. Removing the off-slab fallback
   * also closes the slab/chrome lifecycle desync where the band
   * lingered after `/computer` toggle.
   */
  /**
   * chrome-1b — public refresh hook. Called by surfaces (e.g. the
   * `/sensitivity` and `/vision` slash commands) after they mutate
   * runtime state, so the strip's sensitivity ring + pixel-consent
   * eye reflect the truth without waiting for the next control-
   * state transition. Cheap — just rebuilds the strip element from
   * current state and replaces it in the slot.
   */
  refreshSlabChrome(): void {
    // Fail-soft when DOM is unavailable (Node test envs without
    // jsdom). The setter-bundled refresh from setPersistedCookies
    // fires unconditionally to preserve the runtime invariant; the
    // env guard keeps that invariant safe to call from any code path
    // — including the cookies-arc's lazy load that resolves before
    // the slab chrome is rendered, and the test harness's bootstrap
    // path that exercises persistence without a live DOM. The
    // production path (browser env) always has document available;
    // this guard only no-ops in the test env.
    if (typeof document === "undefined") return;
    this.applyChromeToCurrentState();
  }

  /**
   * Set the task-step narration for the current turn and refresh the
   * slab chrome so the `motebit × virtual_browser` register picks up
   * the new content. Called by stream consumers (chat.ts) when a
   * `task_step_narration` chunk arrives. Pass null to clear the
   * narration at turn end so the register recedes to the empty state
   * before the next turn begins.
   *
   * Idempotent across identical inputs — refresh fires regardless so
   * the chrome stays in lockstep with the typed signal even if the
   * caller re-emits the same string.
   */
  setTaskStepNarration(narration: string | null): void {
    this._taskStepNarration = narration;
    this.refreshSlabChrome();
  }

  /**
   * Compute the slab home view's forward-framed affordances by
   * querying the motebit's `UserInputForwarded` event log for past
   * navigate events (host-redacted audit format per `co-browse.ts`
   * §"URL-redacted navigate detail"). Dedups by host; returns the
   * 4 most-recent hosts. Each affordance is a calm tile on the
   * slab body's empty register — "Continue google.com," act-framed
   * launchpad informed by past affinity, not a chronological record
   * list.
   *
   * Doctrine: `records-vs-acts.md` — body shows acts, panels hold
   * records. Same signed receipts feed both surfaces but with
   * different reading registers; this path is the act register.
   *
   * Fail-soft: a query fault returns an empty list, the home view
   * collapses to its empty-empty fallback (pure slab interior, no
   * decorative chrome). First-time users land here too.
   */
  /**
   * Convert an `InteriorColor.tint` triplet (linear-space rgb in
   * [0, 1]) to a CSS hex string (`#rrggbb`) suitable for the home
   * view's soul-tinted tile background. Gamma is left linear here
   * because tiles read fine under the slab's transmission shader
   * without a sRGB conversion at the CSS layer; if a perceptual
   * delta surfaces, swap for a sRGB-encoded variant.
   */
  private tintToHex(tint: readonly [number, number, number]): string {
    const clamp = (v: number): number => Math.max(0, Math.min(1, v));
    const hex = (v: number): string =>
      Math.round(clamp(v) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${hex(tint[0])}${hex(tint[1])}${hex(tint[2])}`;
  }

  /**
   * Navigate-audit rows for the home seed's resumption basis — cached
   * after the first read and appended-to in `emitUserInputAudit`, so a
   * home mount never re-scans the full forwarded-input history (every
   * click/key/scroll appends a row; only navigates matter here).
   */
  private _homeNavCache: Array<{ payload: UserInputForwardedPayload; timestamp: number }> | null =
    null;

  private async getHomeNavigateEvents(): Promise<
    Array<{ payload: UserInputForwardedPayload; timestamp: number }>
  > {
    if (this._homeNavCache != null) return this._homeNavCache;
    if (!this.runtime) return [];
    try {
      const events = await this.runtime.events.query({
        motebit_id: this._motebitId,
        event_types: [EventType.UserInputForwarded],
      });
      this._homeNavCache = events
        .map((e) => ({
          payload: e.payload as unknown as UserInputForwardedPayload,
          timestamp: e.timestamp,
        }))
        .filter((e) => e.payload?.detail?.kind === "navigate");
      return this._homeNavCache;
    } catch {
      // Audit-log read fault is non-fatal — empty resumption basis.
      return [];
    }
  }

  /**
   * Assemble the home-seed inputs — every config key answered from a
   * LIVE runtime accessor, never a cached or authored bit ("derive the
   * seed; never author it"; the accessor coupling is anchored by
   * check-home-seed-basis):
   *   mind     ← runtime.isAIReady          (loop deps wired — a real gate)
   *   relay    ← syncStatus === "connected"
   *   computer ← computerRegistration != null (env-gated at boot)
   */
  private async buildHomeSeedInputs(): Promise<HomeSeedInputs> {
    const navigateEvents = await this.getHomeNavigateEvents();
    return {
      identity: { motebitId: this._motebitId },
      config: {
        mind: this.runtime?.isAIReady ?? false,
        relay: this._syncStatus === "connected",
        computer: this.computerRegistration != null,
      },
      toolNames:
        this.runtime
          ?.getToolRegistry()
          .list()
          .map((t) => t.name) ?? [],
      navigateEvents,
    };
  }

  /**
   * Recompute the home register from `_currentBrowserUrl` and apply
   * the matching slab body state:
   *
   *   On home register (URL is null or "about:blank"):
   *     - `setHomeVisible(true)` on the handle (body slot visible)
   *     - `clearSlabScreencast()` so any prior session's last frame
   *       releases its texture and the screen mesh's per-frame
   *       visibility derives false (`41e28ead` binding)
   *     - Build + mount the home view DOM (affordance tiles or
   *       empty-empty wrapper) into `bodySlot`
   *
   *   Off home register (real URL navigated):
   *     - `setHomeVisible(false)` (body slot hidden via display:none)
   *     - Incoming screencast frames resume routing to the screen
   *       mesh through the normal `onFrameDecoded` path
   *
   * The per-frame `onFrameDecoded` callback (`mountLiveBrowserShell`)
   * reads `_onHomeRegister` and skips `setSlabScreencastImage` while
   * on home register — `about:blank` whitescreens don't compete with
   * the home view for the body.
   */
  /**
   * Compose `_onHomeRegister` + `_homeOverlayActive` into the
   * effective bodySlot tri-state and apply via setHomeState.
   * Single source of truth for the slot's display register —
   * called from both the URL-state applier and the overlay
   * focus/blur path.
   */
  private effectiveHomeState(): "hidden" | "register" | "overlay" {
    if (this._onHomeRegister) return "register";
    if (this._homeOverlayActive) return "overlay";
    return "hidden";
  }

  /**
   * Map the same two cause-bits onto the renderer's body register —
   * the typed truth for what occupies the slab's body region. The
   * DOM-side `setHomeState` controls CSS (`display: none` vs flex
   * vs flex+backdrop-blur); the renderer-side `setSlabBodyRegister`
   * controls screen-mesh visibility (`live` shows the JPEG mesh,
   * `home`/`transition` hide it, `transition` preserves the texture
   * for cold-start-free resume). One state, two physical levers;
   * both derived from the same composition so they cannot drift.
   * Doctrine: `motebit-computer.md` §"Body register — the tri-state."
   */
  private effectiveBodyRegister(): SlabBodyRegister {
    if (this._onHomeRegister) return "home";
    if (this._homeOverlayActive) return "transition";
    return "live";
  }

  private applyHomeRegisterToCurrentState(): void {
    const handle = this.liveBrowserHandle;
    if (!handle) return;
    const url = this._currentBrowserUrl;
    const onHome = url == null || url === "" || url === "about:blank";
    const wasOnHome = this._onHomeRegister;
    this._onHomeRegister = onHome;
    // Real URL navigated → overlay collapses (commit-navigate path);
    // overlay only makes sense while a session is active AND the user
    // is focused. The blur listener also clears this on cancel; the
    // navigate-commit clears it via this branch.
    if (!onHome && this._homeOverlayActive) {
      this._homeOverlayActive = false;
    }
    const state = this.effectiveHomeState();
    handle.setHomeState(state);
    // Renderer-side register write — the typed truth for screen-mesh
    // visibility. Belt-and-suspenders with `clearSlabScreencast` below:
    // the register alone hides the mesh on next tick, even if the
    // texture-release races with the render loop. Doctrine: `motebit-
    // computer.md` §"Body register — the tri-state."
    this.renderer.setSlabBodyRegister?.(this.effectiveBodyRegister());
    if (onHome) {
      // Releasing the texture lets the screen-mesh visibility binding
      // (cd98aa8f / 41e28ead) derive false on the next render tick.
      this.renderer.clearSlabScreencast?.();
      this.mountHomeViewIntoBodySlot();
    } else if (wasOnHome) {
      // Leaving home register → clear the slot so prior tiles don't
      // linger behind the screencast. The slot is display:none now
      // but the children are still in the DOM; replaceChildren keeps
      // memory tidy and prevents stale tap handlers from firing on a
      // re-show with different affordances.
      handle.bodySlot.replaceChildren();
    }
  }

  /**
   * Build affordances and mount the home view into the body slot.
   * Used by BOTH the home-register path (slot shows home view as
   * primary content) AND the overlay path (slot shows home view
   * over a dimmed live session). Same DOM; different backdrop.
   *
   * Async — affordances come from `getSlabHomeAffordances` which
   * queries the audit log. During the await window the slot shows
   * whatever's currently in it (empty on first mount, stale tiles
   * on re-show); refreshes once the query lands. Re-checks the
   * handle + state-machine flags after the await so a concurrent
   * dismiss / navigate / blur doesn't race the mount.
   */
  private mountHomeViewIntoBodySlot(): void {
    const handle = this.liveBrowserHandle;
    if (!handle) return;
    void this.buildHomeSeedInputs().then((inputs) => {
      // Re-check the handle + slot-visibility — the user may have
      // dismissed, navigated, or blurred-out during the await window.
      if (this.liveBrowserHandle !== handle) return;
      if (!this._onHomeRegister && !this._homeOverlayActive) return;
      const seed = deriveHomeSeed(inputs);
      const view = buildSlabHomeView(seed, {
        onTileAction: (action) => this.dispatchHomeTileAction(action),
        soulTint: this._interiorColor ? this.tintToHex(this._interiorColor.tint) : undefined,
      });
      handle.bodySlot.replaceChildren(view);
    });
  }

  /**
   * Typed tile dispatch — each action kind routes to its deterministic
   * seam; no handler carries free text (the action union is promptless
   * by construction, surface-determinism shape-enforced):
   *   navigate      → the live-browser forwardEvent path (as the old
   *                   affordance tap did)
   *   focus_ingress → the chrome strip's ingress (CustomEvent the
   *                   chrome module listens for; falls back to focusing
   *                   the strip's input directly)
   *   open_goals / open_agents / open_setup → typed document
   *                   CustomEvents wired in main.ts to the panel/
   *                   settings openers (the motebit:open-activity
   *                   precedent)
   */
  private dispatchHomeTileAction(action: HomeTileAction): void {
    switch (action.kind) {
      case "navigate": {
        // Synchronous overlay exit BEFORE dispatch — closes the race
        // with the URL-input's deferred blur handler (see the original
        // affordance-tap comment; behavior preserved).
        if (this._homeOverlayActive) {
          this.exitHomeOverlay();
          this.liveBrowserHandle?.element.querySelector("input")?.blur();
        }
        void this.liveBrowserForwardEvent?.({ kind: "navigate", url: action.url });
        break;
      }
      case "focus_ingress": {
        const input =
          this.liveBrowserHandle?.controlBandSlot.querySelector<HTMLInputElement>("input");
        if (input) {
          input.focus();
        } else {
          document.dispatchEvent(new CustomEvent("motebit:home-focus-ingress"));
        }
        break;
      }
      case "open_goals":
        document.dispatchEvent(new CustomEvent("motebit:home-open-goals"));
        break;
      case "open_agents":
        document.dispatchEvent(new CustomEvent("motebit:home-open-agents"));
        break;
      case "open_setup":
        document.dispatchEvent(
          new CustomEvent("motebit:home-open-setup", { detail: { key: action.key } }),
        );
        break;
    }
  }

  /**
   * Enter the home-overlay register from an active session — the
   * Session → Home transition Apple's Safari closes via URL-bar
   * focus. Composites the home view over the still-streaming
   * screencast with a backdrop-blur dim. Session keeps running
   * behind; the user is mid-decision, not mid-teardown.
   *
   * Idempotent. No-op if there's no active live_browser shell
   * (overlay requires a session to overlay), or if already on the
   * home register (where the home view is already the primary
   * content), or if already in overlay.
   */
  private enterHomeOverlay(): void {
    if (!this.liveBrowserHandle) return;
    if (this._onHomeRegister) return;
    if (this._homeOverlayActive) return;
    this._homeOverlayActive = true;
    this.liveBrowserHandle.setHomeState(this.effectiveHomeState());
    // Flip the body register to `transition` — Apple's Safari pattern:
    // the page render is replaced (not blurred-behind) when the URL
    // bar focuses. Texture stays installed so resume is cold-start-
    // free; only visibility flips. Tiles render against pure slab
    // interior, never against a competing video. Doctrine: `motebit-
    // computer.md` §"Body register — the tri-state."
    this.renderer.setSlabBodyRegister?.(this.effectiveBodyRegister());
    this.mountHomeViewIntoBodySlot();
  }

  /**
   * Exit the home-overlay register — restores the session register.
   * Fired by URL-bar blur (Esc, tap-outside, focus-leave), or by the
   * commit-navigate path inside `applyHomeRegisterToCurrentState`
   * which also clears the flag idempotently. The slot's home view
   * gets cleared so it doesn't render under the screencast on the
   * next overlay open (stale tile flash).
   */
  private exitHomeOverlay(): void {
    if (!this.liveBrowserHandle) return;
    if (!this._homeOverlayActive) return;
    this._homeOverlayActive = false;
    this.liveBrowserHandle.setHomeState(this.effectiveHomeState());
    // Flip the body register back to `live` — per-frame visibility
    // derivation reveals the mesh on the next render tick against
    // the most-recent frame already in the texture (no cold-start,
    // no blank). Doctrine: `motebit-computer.md` §"Body register —
    // the tri-state."
    this.renderer.setSlabBodyRegister?.(this.effectiveBodyRegister());
    // Clear the slot so the next overlay-open rebuilds fresh tiles
    // (in case the audit log got new entries between opens).
    this.liveBrowserHandle.bodySlot.replaceChildren();
  }

  /**
   * Stable session-aware forward closure mounted on the shell at
   * boot. Routes every URL-bar / input-capture event the same way:
   *
   *   - Reads `_activeBrowserSessionId` lazily on each call so a
   *     single closure serves pre-session, session-live, and
   *     post-session registers.
   *   - Pre-session: triggers `ensureDefaultSession` to lazy-open
   *     a cloud session, then dispatches through the freshly-
   *     attached session id. URL-bar typing in the READY register
   *     pre-warms the session.
   *   - Session-live: dispatches directly through
   *     `sessionManager.forwardUserInput`.
   *   - Post-session (cloud unreachable): returns a degraded
   *     outcome so the chrome can render a "couldn't navigate"
   *     register.
   *
   * Returns null when no cloud-browser registration exists —
   * surfaces without the cloud tool render a non-functional input,
   * but the shell still mounts (chrome reads as ready, URL-bar
   * typing is no-op). Captured ONCE per WebApp at shell-mount
   * time; reads instance state on every call.
   */
  private buildSessionAwareForwardEvent():
    | ((
        event: import("@motebit/sdk").UserInputEvent,
      ) => Promise<import("@motebit/runtime").UserInputForwardResult>)
    | null {
    const reg = this.computerRegistration;
    if (!reg) return null;
    return async (event) => {
      let sessionId = this._activeBrowserSessionId;
      if (!sessionId) {
        // READY register typing — lazy-open the session.
        // Idempotent: in-flight calls funnel through the same
        // `ensureDefaultSession` promise. On success,
        // `onSessionLive` fires synchronously inside this await
        // and sets `_activeBrowserSessionId`; we re-read it to
        // dispatch.
        const handle = await reg.ensureDefaultSession();
        sessionId = handle?.session_id ?? this._activeBrowserSessionId;
        if (!sessionId) {
          return {
            outcome: "denied",
            reason: "session_unavailable",
          } as unknown as import("@motebit/runtime").UserInputForwardResult;
        }
      }
      const result = await reg.sessionManager.forwardUserInput(sessionId, event);
      await this.emitUserInputAudit(result.audit);
      // chrome-1a-fix / prompt-1 — capture the user-typed URL when a
      // user-driven navigate forwards cleanly. Sibling of the
      // motebit-driven path's `onNavigateResult` callback.
      if (event.kind === "navigate" && result.outcome === "forwarded") {
        this._currentBrowserUrl = event.url;
        this.applyChromeToCurrentState();
        // URL state changed via user-typed navigate → home register
        // re-applies. Off-home transition hides the body slot and
        // resumes screencast frame routing.
        this.applyHomeRegisterToCurrentState();
      }
      return result;
    };
  }

  private applyChromeToCurrentState(): void {
    const handle = this.liveBrowserHandle;
    const machine = this.computerRegistration?.coBrowseControl;
    // The shell's stable session-aware forward closure handles every
    // register (pre-session lazy-open, session-live direct dispatch,
    // unreachable degraded). One closure, one entry point —
    // no per-register branching here.
    const forwardEvent = this.liveBrowserForwardEvent;
    const state = machine?.getState();
    if (!state || !machine) return;

    // State-driven chrome via the matrix-shaped dispatcher
    // (`renderSlabChrome` = `f(controlState × embodimentMode)`). PR 1
    // fills the `* × virtual_browser` column; the
    // `motebit × virtual_browser` register renders the task-step
    // narration the runtime validated this turn, while the other
    // cells delegate to the existing cobrowse chrome unchanged.
    // Other embodiment columns are named in the dispatcher and
    // deferred. Doctrine: `chrome-as-state-render.md`.
    const chrome = renderSlabChrome(state, "virtual_browser", machine, {
      forwardEvent,
      interiorColor: this._interiorColor,
      sensitivity: this.runtime?.getSessionSensitivity(),
      pixelConsent: this.runtime?.getPixelConsent(),
      // Real browser convention: URL bar shows current URL. We
      // surface this whenever the surface knows it, regardless of
      // who's driving — `motebit`-driving renders read-only
      // display, `user`-driving renders pre-populated input.
      currentUrl: this._currentBrowserUrl,
      // Phase 2 trust-accumulation visibility — calm pip between
      // mark and URL when motebit holds persisted cookies for the
      // current host. Predicate is pure (no I/O) so this is cheap
      // to evaluate on every chrome refresh; the in-memory
      // `_persistedCookies` cache is populated by the cookies arc's
      // lazy-load gate on first session open and stays warm.
      trustHeld: urlHasTrustHeld(this._currentBrowserUrl, this._persistedCookies),
      // Rest-cell ingress honesty (motebit-computer.md §home): the mode
      // derives from the SAME live accessor as the seed's `mind` bit —
      // a bare motebit's ingress says "go somewhere", never offering a
      // chat that cannot think. onAsk carries USER-AUTHORED text to the
      // normal chat send path (address-me, not a synthesized prompt).
      homeIngress: {
        mode: (this.runtime?.isAIReady ?? false) ? ("ask_or_go" as const) : ("go_only" as const),
        onAsk: (text: string) => {
          document.dispatchEvent(new CustomEvent("motebit:home-ask", { detail: { text } }));
        },
      },
      taskStepNarration: this._taskStepNarration,
      // PR 4 of the auto-routing arc — second narration source the
      // chrome absorbs. Populated by the BYOK / on-device auto-
      // router intercepts in `sendMessageStreaming` (the surface
      // that runs the dispatcher locally). Null on motebit-cloud /
      // BYOK-without-autoRoute paths — calm-software default.
      routingNarration: this._routingNarration,
    });

    // No live_browser handle = no session = nothing to control.
    // The slab is gated on intent (`invokeComputer` mounts the
    // shell on `/computer` slash command, AI tool call, etc.); if
    // a co-browse state fires before the shell mounts, drop the
    // chrome on the floor — the next state transition after mount
    // will reapply it.
    if (!handle) return;

    // The dispatcher returns null for embodiment columns deferred to
    // PR N; web's live_browser always renders `virtual_browser`, so
    // the chrome is always an element in this code path. Belt-and-
    // suspenders: clear the slot if the dispatcher ever returns null.
    if (!chrome) {
      handle.controlBandSlot.replaceChildren();
      handle.addressBarSlot.replaceChildren();
      return;
    }

    handle.controlBandSlot.replaceChildren(chrome);
    // The address-bar slot is now empty by design — the unified
    // strip in controlBandSlot absorbs its content. Clear in case
    // a prior render left an element behind.
    handle.addressBarSlot.replaceChildren();

    // URL-bar focus → Session→Home transition. Wire focus/blur on
    // the (just-mounted) URL input so URL-bar focus mid-session
    // surfaces the home-overlay register. The input is rebuilt on
    // every chrome render (apps/web mounts chrome state-machine-
    // driven), so listeners are attached per render — old DOM gets
    // GC'd with the old listeners.
    const urlInput = chrome.querySelector("input");
    if (urlInput) {
      urlInput.addEventListener("focus", () => this.enterHomeOverlay());
      urlInput.addEventListener("blur", () => {
        // Defer overlay exit by one task. When the user clicks a
        // tile, focus moves to the button → input fires blur
        // synchronously. If we hide the slot here (display:none),
        // some browsers won't dispatch the click on the now-hidden
        // button child between mousedown and mouseup. setTimeout(0)
        // queues the exit after the current event-loop tick so the
        // click completes first; the navigate-commit path then
        // clears the overlay idempotently via the URL-state applier.
        setTimeout(() => this.exitHomeOverlay(), 0);
      });
      // Esc on the URL input → blur it. The deferred blur handler
      // above exits the overlay. Browser default Esc-on-input
      // cancels IME composition but doesn't blur, so we do both:
      // blur the input (which exits overlay) AND restore the
      // input's value to the current URL so edits are discarded.
      urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this._homeOverlayActive) {
          if (this._currentBrowserUrl != null) {
            urlInput.value = this._currentBrowserUrl;
          }
          urlInput.blur();
        }
      });
    }
  }

  /**
   * Slice 2c — append a `UserInputForwarded` audit entry to the
   * event log. Sibling of the co-browse-control audit emission
   * (`emitControlEvent` in computer-tool.ts) and the session-open/
   * close emissions. Best-effort: a sink fault must not break
   * input forwarding (the wire already landed by the time this
   * fires).
   */
  private async emitUserInputAudit(payload: UserInputForwardedPayload): Promise<void> {
    if (!this.runtime) return;
    const events = this.runtime.events;
    if (events == null) return;
    try {
      const entry = {
        event_id: crypto.randomUUID(),
        motebit_id: this._motebitId,
        timestamp: payload.timestamp,
        event_type: EventType.UserInputForwarded,
        payload: payload as unknown as Record<string, unknown>,
        tombstoned: false,
      };
      if (typeof events.appendWithClock === "function") {
        await events.appendWithClock(entry);
      } else {
        await events.append({ ...entry, version_clock: 0 });
      }
      // Keep the home seed's resumption cache warm — navigates are the
      // only rows it reads, so appending here means the next home mount
      // never re-scans the full forwarded-input history.
      if (payload.detail?.kind === "navigate" && this._homeNavCache != null) {
        this._homeNavCache.push({ payload, timestamp: payload.timestamp });
      }
    } catch {
      // Audit-sink fault is non-fatal — the input has already
      // landed at Chromium; a logging failure must not bounce
      // the next keystroke.
    }
  }

  /**
   * Detach the active cloud session from the shell. Pairs with
   * `attachSessionToLiveBrowser`. The shell itself stays mounted —
   * only the session-bound state clears. After this call the chrome
   * returns to its READY register: empty URL bar, control band
   * shows the post-session control state.
   *
   * Frame source (the bus) keeps its subscription. Once a future
   * `ensureDefaultSession` opens a new session and the dispatcher
   * publishes new frames, they flow through the existing
   * `onFrameDecoded` path without re-mounting anything.
   */
  private detachSessionFromLiveBrowser(): void {
    this._activeBrowserSessionId = null;
    // Stop the keepalive timer — no session to keep alive.
    this.stopCloudSessionKeepalive();
    // Release the slab's WebGL screen-mesh texture so the body
    // returns to its empty register. Sibling of setSlabScreencastImage;
    // a subsequent session's first frame re-allocates cleanly.
    this.renderer.clearSlabScreencast?.();
    // Re-render chrome — the strip transitions back to the
    // pre-session register (URL bar empty, control band reads the
    // post-session control state).
    this.applyChromeToCurrentState();
  }

  /**
   * Cloud-session keepalive timer — fires `computerRegistration.
   * keepalive()` on a fixed interval (60s) while a cloud-browser
   * session is mounted. The sandbox's idle reaper at
   * BROWSER_SANDBOX_IDLE_MS (10min) tears down sessions whose
   * `lastUsedAt` is past the cutoff; keeping the timestamp fresh
   * keeps the session warm across the user's idle gaps.
   *
   * Doctrine binding: "accumulated trust" — a CAPTCHA-cleared
   * Google session has reputation capital invested in it; the
   * reaper destroys that capital every 10 minutes of inactivity.
   * The keepalive amortizes the investment across the user's
   * working attention window without making sessions unboundedly
   * long (closing the motebit tab stops the timer; normal reaper
   * takes over).
   *
   * Idempotent: calling `startCloudSessionKeepalive` while a timer
   * is already running is a no-op. Cleared by
   * `stopCloudSessionKeepalive`, which is called on detach +
   * dispose. Errors during a ping are swallowed (fail-soft — a
   * transient sandbox blip shouldn't cascade into UI failures;
   * the worst case is the reaper fires on the next idle window,
   * which is the pre-fix behavior).
   */
  private _cloudKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly CLOUD_KEEPALIVE_INTERVAL_MS = 60_000;

  private startCloudSessionKeepalive(): void {
    if (this._cloudKeepaliveTimer !== null) return;
    if (typeof setInterval === "undefined") return;
    this._cloudKeepaliveTimer = setInterval(() => {
      void this.computerRegistration?.keepalive().catch(() => {
        // Fail-soft — a transient sandbox blip doesn't cascade.
        // If keepalive is consistently failing, the reaper will
        // fire on the next idle window and the user lands back at
        // the pre-fix behavior. The chat surfaces broader errors
        // via the normal tool-failure paths.
      });
    }, WebApp.CLOUD_KEEPALIVE_INTERVAL_MS);
  }

  private stopCloudSessionKeepalive(): void {
    if (this._cloudKeepaliveTimer === null) return;
    clearInterval(this._cloudKeepaliveTimer);
    this._cloudKeepaliveTimer = null;
  }

  /**
   * Lazy-load the persisted cookie jar from IndexedDB into the
   * in-memory cache. Idempotent — the load runs once per WebApp
   * lifetime, gated by `_cookieStoreLoadOnce`. Subsequent
   * `getInitialCookies` calls serve from `_persistedCookies` after
   * the first load resolves.
   *
   * Failures fail-soft: the cache stays empty, the user gets
   * cold-start cookies on the next cloud session. Same posture as
   * the encrypted-cookie-store itself — accumulated-trust degrades
   * to no-trust under error, not to broken-session.
   */
  private ensureCookieStoreLoaded(motebitId: string): Promise<void> {
    if (this._cookieStoreLoadOnce !== null) return this._cookieStoreLoadOnce;
    this._cookieStoreLoadOnce = loadCookies(motebitId)
      .then((cookies) => {
        this.setPersistedCookies(cookies);
      })
      .catch(() => {
        // Already swallowed inside loadCookies; defensive double-
        // catch so the once-promise resolves cleanly even on
        // unexpected throws.
      });
    return this._cookieStoreLoadOnce;
  }

  /**
   * Canonical setter for `_persistedCookies` — invariant: every write
   * to the cookie cache triggers a chrome refresh so the Phase 2
   * trust-visibility pip stays coherent with the in-memory state.
   *
   * The runtime-invariants-over-prompt-rules doctrine applied to my
   * own code: rather than asking every call-site to remember to call
   * `refreshSlabChrome` after touching cookies (the kind of
   * conformance-shaped rule the doctrine warns against), the
   * structural invariant lives at the setter. The bug it prevents:
   * `/cookies revoke` cleared the cache but didn't refresh the
   * chrome, so the pip stayed visible after revoke until the next
   * navigate / focus / sensitivity change happened to refresh chrome
   * from a different path. Setter-bundled refresh makes that
   * impossible.
   *
   * `refreshSlabChrome` safely no-ops when the slab isn't mounted
   * (machine/runtime not yet wired) so calling from the lazy-load
   * path is safe; the load typically resolves before the slab first
   * renders anyway.
   */
  private setPersistedCookies(
    next: readonly import("@motebit/runtime").PersistentCookieWire[],
  ): void {
    this._persistedCookies = next;
    this.refreshSlabChrome();
  }

  /**
   * Phase 3 of the persistent user_data_dir arc — `/cookies status`
   * reads from here. Returns the cookie jar motebit is holding at
   * rest for this motebitId; lazy-loads from the encrypted store on
   * first access. Read-only — mutations go through
   * `clearPersistedCookies`. Returns `[]` pre-bootstrap (no motebitId
   * yet) or on load failure (fail-soft).
   */
  async getPersistedCookies(): Promise<readonly import("@motebit/runtime").PersistentCookieWire[]> {
    if (!this._motebitId) return [];
    await this.ensureCookieStoreLoaded(this._motebitId);
    return this._persistedCookies;
  }

  /**
   * Phase 3 of the persistent user_data_dir arc — `/cookies revoke`
   * routes here. Clears the at-rest encrypted store AND the in-memory
   * cache; returns a snapshot of what was cleared so the caller can
   * show the user what they revoked.
   *
   * Active sessions: the cleared state covers the at-rest jar; a
   * currently-open cloud session retains its cookies inside Playwright
   * until the session closes. When the session closes,
   * `onCookiesPersisted` fires with the session's live cookies and
   * those become the new at-rest set — accumulation post-revoke is
   * fresh trust, not a hidden undo. The user message documents this
   * honestly.
   */
  async clearPersistedCookies(): Promise<
    readonly import("@motebit/runtime").PersistentCookieWire[]
  > {
    if (!this._motebitId) return [];
    await this.ensureCookieStoreLoaded(this._motebitId);
    const snapshot = this._persistedCookies;
    this.setPersistedCookies([]);
    await clearCookies(this._motebitId);
    return snapshot;
  }

  /**
   * v1.5 detach — emerge a signed `ComputerSessionReceipt` as a
   * verifiable artifact in the scene.
   *
   * Doctrine-canonical path (preferred): when a `live_browser` slab
   * item is currently mounted in a non-terminal phase, route through
   * `slab.endItem(id, {kind: "completed", detachAs: "receipt", result:
   * receipt})`. The slab controller transitions the item through
   * `pinching → detached`, the slab-bridge picks up the
   * `__slabDetach` marker, `renderDetachArtifact` builds the canonical
   * receipt element with the signed receipt embedded, and the
   * renderer's `detachSlabItemAsArtifact` plants it in the scene with
   * the pinch animation. The membrane-out crossing is signed and
   * physically visible — content leaves the slab carrying its
   * provenance, symmetric to drag-drop's signed perception-in. Closes
   * the asymmetry named in `liquescentia-as-substrate.md`
   * §"Cohesive permeability."
   *
   * Fallback path (legacy): if no slab item is mounted (session
   * completed after the slab was already dismissed) OR if `endItem`
   * faults (item already in terminal phase), drop the receipt
   * directly into the scene via `addArtifact`. Same DOM shape, same
   * dismiss mechanism — just no pinch animation because there's no
   * slab item to pinch from.
   *
   * Exposed as a method (not inlined into the registration) so the
   * desktop surface can drive the same emergence path through the
   * shared `WebApp` / `DesktopApp` pattern, and tests can fire the
   * emergence in isolation. No-ops in environments without `document`.
   */
  emergeSessionReceipt(receipt: ComputerSessionReceipt): void {
    if (typeof document === "undefined") return;

    const itemId = this.liveBrowserItemId;
    if (itemId !== null && this.runtime != null) {
      try {
        this.runtime.slab.endItem(itemId, {
          kind: "completed",
          result: receipt,
          detachAs: "receipt",
        });
        // Slab pinch physics now drives emergence. The bridge fires
        // renderDetachArtifact → detachSlabItemAsArtifact on the
        // renderer; the artifact carries the receipt as its bead.
        // Clear local mount state so a subsequent /computer rebuilds
        // a fresh shell rather than reusing the now-detached id.
        this.liveBrowserItemId = null;
        this.liveBrowserHandle = null;
        return;
      } catch {
        // Item already in terminal phase (dismissed during the
        // close-sign race) — fall through to direct addArtifact.
      }
    }

    // Legacy fallback — no slab item to detach from. Receipt still
    // emerges, just not via pinch physics.
    const id = `csr-${receipt.receipt_id}`;
    const el = buildComputerSessionReceiptArtifact(receipt, () => {
      this.removeArtifact(id);
    });
    this.addArtifact({ id, kind: "receipt", element: el });
  }

  removeArtifact(id: string): void {
    void this.renderer.removeArtifact?.(id);
  }

  clearArtifacts(): void {
    this.renderer.clearArtifacts?.();
  }

  // === Goals (one-shot, user-triggered) ===

  async *executeGoal(goalId: string, prompt: string): AsyncGenerator<PlanChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");

    yield* this.runtime.executePlan(goalId, prompt);
  }

  async *resumeGoal(planId: string): AsyncGenerator<PlanChunk> {
    if (!this.runtime) throw new Error("Runtime not initialized");
    if (!this.runtime.isAIReady) throw new Error("No provider connected");

    yield* this.runtime.resumePlan(planId);
  }

  // === Sync ===

  get syncStatus(): WebSyncStatus {
    return this._syncStatus;
  }

  onSyncStatusChange(cb: (status: WebSyncStatus) => void): () => void {
    this._syncStatusListeners.add(cb);
    return () => {
      this._syncStatusListeners.delete(cb);
    };
  }

  private setSyncStatus(status: WebSyncStatus): void {
    const changed = this._syncStatus !== status;
    this._syncStatus = status;
    for (const cb of this._syncStatusListeners) cb(status);
    // Config-state changed while the slab rests on home → re-derive the
    // seed (a relay connecting mid-rest surfaces Find-an-agent; a
    // disconnect recedes it — the mirror stays live, never stale).
    if (changed && (this._onHomeRegister || this._homeOverlayActive)) {
      this.mountHomeViewIntoBodySlot();
    }
  }

  async createSyncToken(aud: TokenAudience = "sync"): Promise<string | null> {
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex == null || privateKeyHex === "") return null;

    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }

    try {
      return await createSignedToken(
        {
          mid: this._motebitId,
          did: this._deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud,
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }

  async startSync(relayUrl: string): Promise<void> {
    if (!this.runtime) throw new Error("Runtime not initialized");

    this.setSyncStatus("connecting");

    // Get private key for token + encryption key derivation
    const privateKeyHex = await this.keyStore.loadPrivateKey();
    if (privateKeyHex == null || privateKeyHex === "") {
      this.setSyncStatus("error");
      throw new Error("No device keypair available for sync authentication");
    }

    const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
    for (let i = 0; i < privateKeyHex.length; i += 2) {
      privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
    }

    // ── Self-attesting device registration ──────────────────────────────
    // Before any signed-token request, ensure the relay knows this device's
    // public key. Otherwise every subsequent fetch 401s — the relay can't
    // verify a token signed by a key it has never seen. Idempotent: subsequent
    // page loads re-register, the relay short-circuits on matching public_key.
    // Spec: spec/device-self-registration-v1.md.
    //
    // Failures here degrade honestly via setSyncStatus("error") + a console
    // warning; the surface-determinism path's own `sync_not_enabled` /
    // `auth_expired` codes will surface a user-facing remediation if the
    // user later attempts a deterministic invocation.
    try {
      const reg = await registerDeviceWithRelay({
        motebitId: this._motebitId,
        deviceId: this._deviceId,
        publicKey: this._publicKeyHex,
        privateKey: privKeyBytes,
        syncUrl: relayUrl,
        deviceName: "web",
      });
      if (!reg.ok) {
        // Log once — the user-visible failure surfaces through the chip-tap
        // path's `sync_not_enabled` copy if/when they try to invoke.
        // eslint-disable-next-line no-console -- honest-degrade diagnostic; user-facing remediation arrives via the deterministic-invocation path
        console.warn("[motebit] device self-registration failed:", reg.code, reg.message);
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- honest-degrade diagnostic; user-facing remediation arrives via the deterministic-invocation path
      console.warn(
        "[motebit] device self-registration threw:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // First network action → announce to the intake ledger, silently. Enabling
    // sync is the motebit's first relay presence; that's the calm, consent-free
    // moment to be counted (a purely-local motebit never reaches here and stays
    // uncounted). Best-effort + idempotent: gated on `isAnnounced` so it runs
    // only until the relay first confirms, never re-announces, never blocks
    // sync, and retries on the next connect if it fails.
    if (!isAnnounced()) {
      void this.announceMotebit();
    }

    // Derive deterministic encryption key, then erase raw key bytes.
    const encKey = await deriveSyncEncryptionKey(privKeyBytes);
    secureErase(privKeyBytes);

    const token = await this.createSyncToken();
    if (token == null) {
      this.setSyncStatus("error");
      throw new Error("No device keypair available for sync authentication");
    }

    // Hardware-attestation cascade is available on demand via
    // `mint-hardware-credential.ts` (WebAuthn → software), but the
    // bootstrap-time publish-and-submit path was removed: the relay
    // rejects self-issued credentials at /api/v1/agents/:id/credentials/submit
    // per spec/credential-v1.md §23. Direct submission was a silent no-op.
    // Future peer-attestation flow is the correct surface for routing
    // aggregation per spec §3.4.

    // Fresh-token credential source — re-mints the signed sync token PER
    // REQUEST (HTTP) / per connect (WS). The `token` above is a 5-minute JWT;
    // handing that static string to the long-lived sync adapters meant a
    // session open >5 min reused an expired token and the relay 403'd every
    // /sync call (AUTHZ_DEVICE_NOT_AUTHORIZED — an expired signature reads as
    // "device not authorized"). The adapters resolve a credentialSource on
    // each request, so it never goes stale. (The AI-loop delegation path
    // already uses a fresh provider — `delegationAuthToken` below — so this is
    // the data-sync gap specifically, not the delegation path.)
    const syncCredentialSource: CredentialSource = {
      getCredential: () => this.createSyncToken("sync"),
    };

    // Build adapter stack: HTTP → Encrypted HTTP → WS → Encrypted WS
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: relayUrl,
      motebitId: this._motebitId,
      credentialSource: syncCredentialSource,
    });
    const encryptedHttp = new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey });

    // WebSocket URL
    const wsUrl =
      relayUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) +
      "/ws/sync/" +
      this._motebitId;

    const localEventStore = this._localEventStore;
    const wsAdapter = new WebSocketEventStoreAdapter({
      url: wsUrl,
      motebitId: this._motebitId,
      credentialSource: syncCredentialSource,
      capabilities: [DeviceCapability.HttpMcp],
      httpFallback: encryptedHttp,
      localStore: localEventStore ?? undefined,
    });
    this._wsAdapter = wsAdapter;

    // Wire delegation adapter so PlanEngine can delegate steps to capable
    // devices. Same staleness fix: a fresh-token provider that re-mints per
    // call, honoring the requested audience (defaults to the prior "sync").
    const delegationAdapter = new RelayDelegationAdapter({
      syncUrl: relayUrl,
      motebitId: this._motebitId,
      authToken: (audience?: TokenAudience) =>
        this.createSyncToken(audience ?? "sync").then((t) => t ?? ""),
      sendRaw: (data: string) => wsAdapter.sendRaw(data),
      onCustomMessage: (cb) => wsAdapter.onCustomMessage(cb),
      getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
    });
    this.runtime.setDelegationAdapter(delegationAdapter);

    // Enable interactive delegation — lets the AI transparently delegate
    // tasks to remote agents during conversation.
    const delegationAuthToken = async (audience?: TokenAudience) => {
      const aud = audience ?? "task:submit";
      const t = await this.createSyncToken(aud);
      return t ?? "";
    };
    // Resolve the PINNED relay key (trust-on-first-use) so a paid P2P
    // delegation derives the fee-leg treasury from a key trusted at first
    // connect, never a per-delegation fetch (the irreversible-payment MITM
    // surface — see @motebit/runtime relay-key-pin + off-ramp-as-user-action.md
    // § Arc 3.5). undefined → paid P2P stays disabled and delegation uses
    // relay-mode (e.g. a fail-closed key mismatch); relay-mode still serves
    // every task. Shared by both delegation entry points below.
    const pinnedRelayKey = await getOrPinRelayKey(relayUrl, { storage: localStorage });

    this.runtime.enableInteractiveDelegation({
      syncUrl: relayUrl,
      authToken: delegationAuthToken,
      ...(pinnedRelayKey != null ? { relayPublicKey: pinnedRelayKey } : {}),
      // Forward the cold-start opt-in as a LIVE getter so the "Pay new agents
      // directly" toggle governs chat-driven (delegate_to_agent) delegation,
      // not just the deterministic invokeCapability path. Read per call → no
      // re-enable needed when the user flips it.
      acknowledgeNoHistoryRisk: () => loadColdStartOptIn(),
    });

    // Enable the deterministic surface-determinism path — chip taps, slash
    // commands, scene clicks. Shares the relay coordinates with interactive
    // delegation; differs only in the invocation_origin each path stamps.
    // See docs/doctrine/surface-determinism.md.
    this.runtime.enableInvokeCapability({
      syncUrl: relayUrl,
      authToken: delegationAuthToken,
      ...(pinnedRelayKey != null ? { relayPublicKey: pinnedRelayKey } : {}),
    });

    this._servingSyncUrl = relayUrl;

    // Wire task handler — accept delegations while the tab is open.
    if (this._wsUnsubOnCustom) this._wsUnsubOnCustom();
    this._wsUnsubOnCustom = wsAdapter.onCustomMessage((msg) => {
      // Handle remote command requests (forwarded by relay)
      if (msg.type === "command_request" && this.runtime) {
        // Fail-closed remote ingress: only a signed-request-envelope@1.0
        // from this agent's own identity executes (daemon-desktop
        // unification, increment 4).
        const cmdMsg = msg as unknown as {
          id: string;
          command: string;
          args?: string;
          envelope?: unknown;
        };
        void (async () => {
          try {
            const verdict = await verifyAgentCommandEnvelope({
              envelope: cmdMsg.envelope,
              command: cmdMsg.command,
              args: cmdMsg.args,
              motebitId: this.runtime!.motebitId,
              identityPublicKey: this._publicKeyHex,
            });
            if (!verdict.ok) {
              this._wsAdapter?.sendRaw(
                JSON.stringify({
                  type: "command_response",
                  id: cmdMsg.id,
                  result: { summary: verdict.reason },
                }),
              );
              return;
            }
            const result = await executeCommand(this.runtime!, cmdMsg.command, cmdMsg.args);
            this._wsAdapter?.sendRaw(
              JSON.stringify({ type: "command_response", id: cmdMsg.id, result }),
            );
          } catch (err: unknown) {
            this._wsAdapter?.sendRaw(
              JSON.stringify({
                type: "command_response",
                id: cmdMsg.id,
                result: {
                  summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              }),
            );
          }
        })();
        return;
      }

      if (msg.type !== "task_request" || msg.task == null || !this._serving) return;
      if (!this.runtime) return;

      const task = msg.task as AgentTask;
      const runtime = this.runtime;

      this._wsAdapter?.sendRaw(JSON.stringify({ type: "task_claim", task_id: task.task_id }));
      this._activeTaskCount++;

      void (async () => {
        try {
          const privateKeyHex = await this.keyStore.loadPrivateKey();
          if (!privateKeyHex) return;
          const privKeyBytes = new Uint8Array(privateKeyHex.length / 2);
          for (let i = 0; i < privateKeyHex.length; i += 2) {
            privKeyBytes[i / 2] = parseInt(privateKeyHex.slice(i, i + 2), 16);
          }

          let receipt: ExecutionReceipt | undefined;
          for await (const chunk of runtime.handleAgentTask(
            task,
            privKeyBytes,
            this._deviceId,
            undefined,
            { delegatedScope: task.delegated_scope },
          )) {
            if (chunk.type === "task_result") {
              receipt = chunk.receipt;
            }
          }
          secureErase(privKeyBytes);

          if (receipt) {
            const token = await this.createSyncToken("task:submit");
            await fetch(`${relayUrl}/agent/${this._motebitId}/task/${task.task_id}/result`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(receipt),
            });
          }
        } catch {
          // Task execution failed — receipt not submitted
        } finally {
          this._activeTaskCount = Math.max(0, this._activeTaskCount - 1);
        }
      })();
    });

    const encryptedWs = new EncryptedEventStoreAdapter({ inner: wsAdapter, key: encKey });

    // Inbound real-time events: decrypt and write to local store
    this._wsUnsubOnEvent = wsAdapter.onEvent((raw) => {
      void (async () => {
        if (!localEventStore) return;
        const dec = await decryptEventPayload(raw, encKey);
        await localEventStore.append(dec);
      })();
    });

    this.runtime.connectSync(encryptedWs);
    wsAdapter.connect();

    // Subscribe to SyncEngine status changes
    if (this._syncUnsubscribe) this._syncUnsubscribe();
    this._syncUnsubscribe = this.runtime.sync.onStatusChange((engineStatus: SyncStatus) => {
      if (engineStatus === "syncing") {
        this.setSyncStatus("syncing");
      } else if (engineStatus === "idle") {
        this.setSyncStatus("connected");
      } else if (engineStatus === "error") {
        this.setSyncStatus("error");
      } else if (engineStatus === "offline") {
        this.setSyncStatus("disconnected");
      }
    });

    this.runtime.startSync();
    this.setSyncStatus("connected");

    // Wire plan sync — push/pull plans to relay for cross-device visibility
    if (this._planStore) {
      const planSyncStore = new IdbPlanSyncStore(this._planStore, this._motebitId);
      this._planSyncEngine = new PlanSyncEngine(planSyncStore, this._motebitId);
      const httpPlanAdapter = new HttpPlanSyncAdapter({
        baseUrl: relayUrl,
        motebitId: this._motebitId,
        // Fresh-token source, NOT the static 5-min `token`: PlanSyncEngine
        // polls every 30s, so a session open >5 min reused an expired JWT and
        // the relay 403'd. Same staleness fix the event-store/WS adapters got
        // (see syncCredentialSource above) — this sibling had been missed.
        credentialSource: syncCredentialSource,
      });
      this._planSyncEngine.connectRemote(
        new EncryptedPlanSyncAdapter({ inner: httpPlanAdapter, key: encKey }),
      );
      // Initial plan sync, then background every 30s
      void this._planSyncEngine.sync();
      this._planSyncEngine.start();
    }

    // Wire conversation sync — push/pull conversations to relay for cross-device visibility
    // Encrypted: relay stores opaque ciphertext, same key as event encryption
    if (this._convStore) {
      // Preload all conversation messages so sync push includes locally-modified data
      await this._convStore.preloadAllMessages();
      const convSyncStore = new IdbConversationSyncStore(this._convStore, this._motebitId);
      this._conversationSyncEngine = new ConversationSyncEngine(convSyncStore, this._motebitId);
      const httpConvAdapter = new HttpConversationSyncAdapter({
        baseUrl: relayUrl,
        motebitId: this._motebitId,
        // Fresh-token source, NOT the static 5-min `token`: ConversationSyncEngine
        // polls via .start(), so after 5 min it 403'd on /sync/:id/conversations
        // (the observed failure). Same staleness fix as the sibling sync adapters.
        credentialSource: syncCredentialSource,
      });
      this._conversationSyncEngine.connectRemote(
        new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encKey }),
      );
      void this._conversationSyncEngine.sync();
      this._conversationSyncEngine.start();
    }

    // Recover any delegated steps orphaned by a previous tab close
    void (async () => {
      try {
        for await (const _chunk of this.runtime!.recoverDelegatedSteps()) {
          // Chunks consumed — UI will pick up state changes from the plan store
        }
      } catch {
        // Recovery is best-effort — don't break sync startup
      }
    })();

    // Token refresh every 4.5 min
    this._wsTokenRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          // Unsubscribe old event handler before disconnect to prevent
          // orphaned callbacks firing during the refresh window.
          if (this._wsUnsubOnEvent) {
            this._wsUnsubOnEvent();
            this._wsUnsubOnEvent = null;
          }
          wsAdapter.disconnect();
          const freshToken = await this.createSyncToken();
          if (freshToken == null) return;

          const freshWs = new WebSocketEventStoreAdapter({
            url: wsUrl,
            motebitId: this._motebitId,
            authToken: freshToken,
            capabilities: [DeviceCapability.HttpMcp],
            httpFallback: encryptedHttp,
            localStore: localEventStore ?? undefined,
          });

          // Re-wire delegation adapter with fresh wsAdapter
          const freshDelegation = new RelayDelegationAdapter({
            syncUrl: relayUrl,
            motebitId: this._motebitId,
            authToken: freshToken ?? undefined,
            sendRaw: (data: string) => freshWs.sendRaw(data),
            onCustomMessage: (cb) => freshWs.onCustomMessage(cb),
            getExplorationDrive: () => this.runtime?.getPrecision().explorationDrive,
          });
          this.runtime?.setDelegationAdapter(freshDelegation);

          this._wsUnsubOnEvent = freshWs.onEvent((raw) => {
            void (async () => {
              if (!localEventStore) return;
              const dec = await decryptEventPayload(raw, encKey);
              await localEventStore.append(dec);
            })();
          });

          const freshEncrypted = new EncryptedEventStoreAdapter({ inner: freshWs, key: encKey });
          this.runtime?.connectSync(freshEncrypted);
          freshWs.connect();
          this._wsAdapter = freshWs;
        } catch {
          // Token refresh failed — WS adapter reconnect will retry
        }
      })();
    }, 4.5 * 60_000);

    // Adversarial onboarding: run self-test once after first relay connection
    void this.runOnboardingSelfTest(relayUrl);
  }

  /**
   * Run cmdSelfTest exactly once per device. Uses localStorage flag to avoid
   * repeating on subsequent launches. Best-effort — failures are logged, never blocking.
   */
  private async runOnboardingSelfTest(relayUrl: string): Promise<void> {
    const FLAG = "motebit:self-test-done";
    if (localStorage.getItem(FLAG) === "true") return;
    if (!this.runtime) return;

    try {
      const token = await this.createSyncToken("task:submit");
      if (!token) return;

      const result = await cmdSelfTest(this.runtime, {
        relay: { relayUrl, authToken: token, motebitId: this._motebitId },
        // Honor the audience argument — the relay enforces aud binding
        // (auth-token-v1 §5). Submitting a task uses aud=task:submit;
        // polling its result uses aud=task:query. A single token won't
        // satisfy both endpoints — sending a task:submit token to the
        // /task/:id GET returns 403 (audience mismatch), exactly the
        // cross-endpoint-replay defense the spec defines.
        mintToken: async (audience: TokenAudience) => {
          const t = await this.createSyncToken(audience);
          return t ?? "";
        },
        // Web serving is opt-in (/serve); at onboarding the agent is not a
        // worker, so the completion poll could only time out. Passing the real
        // serving state lets cmdSelfTest return `auth_verified` immediately —
        // the security assertions pass, and we don't run down a 30s doomed poll
        // (and never re-run it: auth_verified sets the done-flag below).
        serving: this._serving,
        timeoutMs: 30_000,
      });

      // eslint-disable-next-line no-console
      console.log("[self-test]", result.summary);
      if (
        result.data?.status === "passed" ||
        result.data?.status === "auth_verified" ||
        result.data?.status === "skipped"
      ) {
        localStorage.setItem(FLAG, "true");
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[self-test] error:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * On-demand security self-test. Sibling to `runOnboardingSelfTest` but
   * triggered by the user's Activity panel button, not bootstrap. Returns
   * the structured result the cross-surface controller projects into the
   * "passed/failed/timeout" badge — no flag flipping, no console-only
   * pathway. The retention manifest + activity log + this probe make
   * the sovereignty-visible trifecta complete on the surface.
   */
  async runSelfTestNow(): Promise<{
    status: "passed" | "auth_verified" | "failed" | "task_failed" | "timeout" | "skipped";
    summary: string;
    hint?: string;
    httpStatus?: number;
    taskId?: string;
  }> {
    if (this.runtime === null) {
      return { status: "skipped", summary: "Self-test skipped — runtime not ready." };
    }
    const relayUrl = loadSyncUrl();
    if (relayUrl === null || relayUrl === "") {
      return { status: "skipped", summary: "Self-test skipped — no relay configured." };
    }
    const token = await this.createSyncToken("task:submit");
    if (token === null) {
      return { status: "skipped", summary: "Self-test skipped — no auth token." };
    }
    const result = await cmdSelfTest(this.runtime, {
      relay: { relayUrl, authToken: token, motebitId: this._motebitId },
      mintToken: async (audience: TokenAudience) => (await this.createSyncToken(audience)) ?? "",
      serving: this._serving,
      timeoutMs: 30_000,
    });
    const data = result.data as
      | {
          status?: "passed" | "auth_verified" | "failed" | "task_failed" | "timeout" | "skipped";
          hint?: string;
          httpStatus?: number;
          taskId?: string;
        }
      | undefined;
    return {
      status: data?.status ?? "failed",
      summary: result.summary,
      hint: data?.hint,
      httpStatus: data?.httpStatus,
      taskId: data?.taskId,
    };
  }

  async startServing(): Promise<{ ok: boolean; error?: string }> {
    if (!this.runtime || !this._servingSyncUrl) {
      return { ok: false, error: "Sync not connected" };
    }
    if (this._serving) return { ok: true };

    const LOCAL_ONLY = new Set([
      "read_file",
      "recall_memories",
      "list_events",
      "self_reflect",
      "delegate_to_agent",
      // Local meta-tool (the live roster read) — never a sellable capability.
      "discover_agents",
    ]);
    const tools = this.runtime.getToolRegistry().list();
    const capabilities = tools
      .filter((t: { name: string }) => !LOCAL_ONLY.has(t.name))
      .map((t: { name: string }) => t.name);

    try {
      const token = await this.createSyncToken();
      const res = await fetch(`${this._servingSyncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          motebit_id: this._motebitId,
          endpoint_url: `wss://${this._motebitId}`,
          public_key: this._publicKeyHex,
          capabilities,
        }),
      });
      if (!res.ok) {
        return { ok: false, error: `Registration failed: ${res.status}` };
      }
      this._serving = true;
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stopServing(): void {
    this._serving = false;
  }

  isServing(): boolean {
    return this._serving;
  }

  stopSync(): void {
    this._serving = false;
    if (this._wsTokenRefreshTimer != null) {
      clearInterval(this._wsTokenRefreshTimer);
      this._wsTokenRefreshTimer = null;
    }
    if (this._wsUnsubOnEvent) {
      this._wsUnsubOnEvent();
      this._wsUnsubOnEvent = null;
    }
    if (this._wsAdapter) {
      this._wsAdapter.disconnect();
      this._wsAdapter = null;
    }
    if (this._syncUnsubscribe) {
      this._syncUnsubscribe();
      this._syncUnsubscribe = null;
    }
    if (this._planSyncEngine) {
      this._planSyncEngine.stop();
      this._planSyncEngine = null;
    }
    if (this._conversationSyncEngine) {
      this._conversationSyncEngine.stop();
      this._conversationSyncEngine = null;
    }
    this.runtime?.sync.stop();
    this.setSyncStatus("disconnected");
  }

  // --- Pairing (multi-device) ---

  async initiatePairing(syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key — initialize identity first");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  async getPairingSession(syncUrl: string, pairingId: string): Promise<PairingSession> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  async approvePairing(syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key");
    const client = new PairingClient({ relayUrl: syncUrl });

    // Build key transfer payload if Device B supports it
    let keyTransfer: KeyTransferPayload | undefined;
    const session = await client.getSession(pairingId, token);
    if (session.claiming_x25519_pubkey) {
      const privateKeyHex = await this.keyStore.loadPrivateKey();
      if (privateKeyHex) {
        const privKeyBytes = hexToBytes(privateKeyHex);
        try {
          keyTransfer = await buildKeyTransferPayload(
            privKeyBytes,
            this._publicKeyHex,
            hexToBytes(session.claiming_x25519_pubkey),
            session.pairing_code,
          );
        } finally {
          secureErase(privKeyBytes);
        }
      }
    }

    const result = await client.approve(pairingId, token, keyTransfer);
    return { deviceId: result.deviceId };
  }

  async denyPairing(syncUrl: string, pairingId: string): Promise<void> {
    const token = await this.createSyncToken("pair");
    if (!token) throw new Error("No signing key");
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  async claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string; ephemeralPrivateKey: Uint8Array }> {
    if (!this._publicKeyHex) throw new Error("No public key — initialize identity first");
    const ephemeral = generateX25519Keypair();
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.claim(
      code.toUpperCase(),
      "Browser",
      this._publicKeyHex,
      bytesToHex(ephemeral.publicKey),
    );
    return { ...result, ephemeralPrivateKey: ephemeral.privateKey };
  }

  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  /**
   * Complete pairing on Device B. If key transfer payload + ephemeral key are provided,
   * decrypts the identity seed and replaces the device's private key.
   */
  async completePairing(
    { motebitId, deviceId }: { motebitId: string; deviceId: string },
    keyTransferOpts?: {
      keyTransfer: KeyTransferPayload;
      ephemeralPrivateKey: Uint8Array;
      pairingCode: string;
      syncUrl: string;
      pairingId: string;
    },
  ): Promise<string | undefined> {
    // Update in-memory identity state
    this._motebitId = motebitId;
    this._deviceId = deviceId;
    let walletWarning: string | undefined;

    if (keyTransferOpts) {
      const { keyTransfer, ephemeralPrivateKey, pairingCode, syncUrl, pairingId } = keyTransferOpts;
      try {
        const identitySeed = await decryptKeyTransfer(
          keyTransfer,
          ephemeralPrivateKey,
          pairingCode,
        );
        try {
          // Safety check: refuse key transfer if old wallet has funds
          const oldPrivKeyHex = await this.keyStore.loadPrivateKey();
          if (oldPrivKeyHex) {
            const oldSeedBytes = hexToBytes(oldPrivKeyHex);
            try {
              const walletCheck = await checkPreTransferBalance(oldSeedBytes, identitySeed);
              if (walletCheck.hasAnyValue) {
                walletWarning = formatWalletWarning(walletCheck);
              }
            } finally {
              secureErase(oldSeedBytes);
            }
          }

          if (!walletWarning) {
            const newPrivHex = bytesToHex(identitySeed);
            await this.keyStore.storePrivateKey(newPrivHex);

            // The new public key is identity_pubkey_check (verified during decryption)
            this._publicKeyHex = keyTransfer.identity_pubkey_check;

            // Update relay device registration
            const client = new PairingClient({ relayUrl: syncUrl });
            await client.updateDeviceKey(pairingId, this._publicKeyHex);
          }
        } finally {
          secureErase(identitySeed);
        }
      } catch {
        // Key transfer failed — device keeps its own keypair, wallet warning stays undefined
      } finally {
        secureErase(ephemeralPrivateKey);
      }
    }
    return walletWarning;
  }
}

/**
 * Fully-booted WebApp — extends UnbootedWebApp with the two slab-mount
 * methods. These methods exist only on this subclass, so `this` inside
 * `UnbootedWebApp.bootstrap()` structurally cannot call them: any attempt
 * is a compile error (Layer 1, bootstrap-internal boundary closed).
 *
 * `main.ts` instantiates as `new WebApp()` and calls `bootstrap()`. The
 * object is always a `WebApp` at runtime; the split enforces phase
 * discipline at the type level, not through a runtime assertion.
 *
 * Doctrine: `intent-gated-slab.md` — slab mounted only on user/AI intent.
 */
export class WebApp extends UnbootedWebApp {
  /**
   * Intent-gated entry point that mounts the live_browser shell and
   * opens the default cloud-browser session. The single idempotent
   * entry point for `/computer` slash command, Option+C, and the AI
   * `computer({...})` tool call.
   *
   * Layer 1 enforcement on TWO boundaries:
   *   - WebContext-callsite: `WebContext.app: BootedApp` (Omit removes
   *     this method) — `initXxx(ctx)` modules cannot call it.
   *   - Bootstrap-internal: this method lives only on `WebApp`, not on
   *     `UnbootedWebApp`, so `this.invokeComputer()` inside `bootstrap()`
   *     (typed `UnbootedWebApp`) is a compile error.
   *
   * Doctrine: `intent-gated-slab.md`.
   */
  invokeComputer(): void {
    if (!this.computerRegistration) return;
    this.mountLiveBrowserShell();
    void this.computerRegistration.ensureDefaultSession().catch(() => {
      // Honest absence — no session, shell stays in READY register.
    });
  }

  /**
   * Counterpart to `invokeComputer`. Closes the active cloud-browser
   * session (which tears down the screencast) then dismisses the slab
   * item. No-op if no session or item is live.
   */
  dismissComputer(): void {
    const sessionId = this._activeBrowserSessionId;
    const itemId = this.liveBrowserItemId;
    if (sessionId != null && this.computerRegistration != null) {
      void this.computerRegistration.sessionManager
        .closeSession(sessionId, "user_dismissed_slab")
        .catch(() => {
          if (this.liveBrowserItemId === itemId && itemId !== null && this.runtime != null) {
            try {
              this.runtime.slab.dismissItem(itemId);
            } catch {
              /* already gone */
            }
            this.liveBrowserItemId = null;
            this.liveBrowserHandle = null;
          }
        });
      this._activeBrowserSessionId = null;
      return;
    }
    if (itemId !== null && this.runtime != null) {
      try {
        this.runtime.slab.dismissItem(itemId);
      } catch {
        /* already gone */
      }
      this.liveBrowserItemId = null;
      this.liveBrowserHandle = null;
    }
  }
}

/**
 * Post-bootstrap view of `WebApp` — structurally lacks `invokeComputer`,
 * `dismissComputer`, and `bootstrap` so any code holding only this type
 * cannot mount the slab or re-bootstrap.
 *
 * Closes BOTH enforcement layers:
 *   - WebContext-callsite (Layer 1): `WebContext.app: BootedApp` means
 *     every `initXxx(ctx)` UI module structurally cannot call slab-mount
 *     methods — compile error, not a comment.
 *   - Bootstrap-internal (Layer 1): `invokeComputer` and `dismissComputer`
 *     exist only on `WebApp`, not on `UnbootedWebApp`. Inside `bootstrap()`
 *     `this: UnbootedWebApp` has no `invokeComputer` — any call is a
 *     compile error.
 *
 * Doctrine: `intent-gated-slab.md`.
 */
export type BootedApp = Omit<WebApp, "invokeComputer" | "dismissComputer" | "bootstrap">;
