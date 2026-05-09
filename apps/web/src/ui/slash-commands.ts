// === Slash Command Autocomplete ===
// Web-specific subset of commands. Desktop-only commands are omitted.

import { addMessage, addExpandableCard } from "./chat";
import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";
import { executeCommand } from "@motebit/runtime";
import type { RelayConfig } from "@motebit/runtime";

/** Build RelayConfig from current web context, or null if not connected. */
async function getRelayConfig(ctx: WebContext): Promise<RelayConfig | null> {
  const syncUrl = loadSyncUrl();
  if (!syncUrl) return null;
  const token = await ctx.app.createSyncToken();
  if (!token) return null;
  return { relayUrl: syncUrl, authToken: token, motebitId: ctx.app.motebitId };
}

/**
 * Execute a shared command and render the result using web UI primitives.
 */
async function trySharedCommand(
  ctx: WebContext,
  name: string,
  args?: string,
  onAudit?: (flags: Map<string, string>) => void,
): Promise<void> {
  const runtime = ctx.app.getRuntime();
  if (!runtime) {
    addMessage("system", "Runtime not initialized.");
    return;
  }

  const relay = await getRelayConfig(ctx);
  try {
    const result = await executeCommand(runtime, name, args, relay ?? undefined);
    if (!result) return;

    if (result.detail) {
      addExpandableCard(result.summary, result.detail);
    } else {
      addMessage("system", result.summary);
    }

    // Special case: audit opens memory panel with flags
    if (name === "audit" && result.data && onAudit) {
      const auditFlags = new Map<string, string>();
      for (const id of (result.data["phantomIds"] as string[]) ?? []) auditFlags.set(id, "phantom");
      for (const id of (result.data["conflictIds"] as string[]) ?? [])
        auditFlags.set(id, "conflict");
      for (const id of (result.data["nearDeathIds"] as string[]) ?? [])
        auditFlags.set(id, "near-death");
      if (auditFlags.size > 0) onAudit(auditFlags);
    }
  } catch (err: unknown) {
    addMessage("system", `${name} error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface SlashCommandDef {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "clear", description: "Clear conversation" },
  { name: "settings", description: "Open settings" },
  { name: "conversations", description: "Browse conversations" },
  { name: "memories", description: "Browse memories" },
  { name: "skills", description: "Browse and install skills" },
  {
    name: "activity",
    description: "View signed deletions, consents, and other audit-grade events",
  },
  { name: "goals", description: "Browse goals" },
  { name: "goal", description: "Quick-add a goal" },
  { name: "computer", description: "Motebit Computer — reveal or hide the slab" },
  { name: "halt", description: "Halt the Motebit Computer — preempt in-flight session dispatch" },
  { name: "resume", description: "Resume the Motebit Computer after a halt" },
  // Co-browse Slice 2b — keyboard-accessible drivers for the slab's
  // control band. Same fail-closed transitions that band-button clicks
  // drive; offered here as power-user / accessibility affordances.
  // `/request` and `/release` are motebit-side and not exposed —
  // user-typed invocations would be `wrong_party` at the machine.
  { name: "grant", description: "Grant Motebit's pending control request" },
  { name: "deny", description: "Deny Motebit's pending control request" },
  { name: "reclaim", description: "Take back control from Motebit" },
  { name: "mcp", description: "MCP server management" },
  { name: "state", description: "Show state vector" },
  { name: "tools", description: "List registered tools" },
  { name: "summarize", description: "Summarize conversation" },
  { name: "model", description: "Show current model" },
  { name: "help", description: "Show keyboard shortcuts" },
  { name: "agents", description: "List known agents" },
  { name: "graph", description: "Memory graph stats" },
  { name: "curious", description: "Show curiosity targets" },
  { name: "reflect", description: "Trigger self-reflection" },
  { name: "export", description: "Export identity + memories" },
  { name: "forget", description: "Delete a memory by keyword" },
  { name: "gradient", description: "Intelligence gradient" },
  { name: "audit", description: "Audit memory integrity" },
  { name: "balance", description: "Show account balance" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "delegate", description: "Delegate task to agent" },
  { name: "approvals", description: "Show pending approvals" },
  { name: "deposits", description: "Show deposit history" },
  { name: "withdraw", description: "Request withdrawal" },
  { name: "plan", description: "Break down a complex goal into steps" },
  { name: "propose", description: "Propose collaborative plan" },
  { name: "proposals", description: "List active proposals" },
  { name: "serve", description: "Toggle accepting delegations" },
  { name: "sensitivity", description: "Show or set session sensitivity tier" },
  { name: "vision", description: "Grant or revoke pixel passthrough for the AI" },
  { name: "receipts", description: "Show recent signed audit receipts" },
];

function filterCommands(partial: string): SlashCommandDef[] {
  const query = partial.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
}

// === DOM Refs ===

const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const autocompleteEl = document.getElementById("slash-autocomplete") as HTMLDivElement;

export interface SlashCommandsCallbacks {
  openSettings(): void;
  openConversations(): void;
  openShortcuts(): void;
  openMemory(auditNodeIds?: Map<string, string>): void;
  openGoals(): void;
  openAgents(): void;
  newConversation(): void;
  /** Toggle the Motebit Computer slab's user-held visibility. */
  toggleSlab(): boolean;
}

export interface SlashCommandsHandle {
  /** Try to execute a slash command from raw input text. Returns true if handled. */
  tryExecute(text: string): boolean;
}

export function initSlashCommands(
  ctx: WebContext,
  callbacks: SlashCommandsCallbacks,
): SlashCommandsHandle {
  let selectedIndex = 0;
  let visible = false;
  let matches: SlashCommandDef[] = [];

  function show(cmds: SlashCommandDef[]): void {
    matches = cmds;
    selectedIndex = 0;
    visible = true;
    render();
    autocompleteEl.classList.add("open");
  }

  function hide(): void {
    visible = false;
    matches = [];
    autocompleteEl.classList.remove("open");
    autocompleteEl.innerHTML = "";
  }

  function render(): void {
    autocompleteEl.innerHTML = "";
    for (let i = 0; i < matches.length; i++) {
      const cmd = matches[i]!;
      const item = document.createElement("div");
      item.className = "slash-autocomplete-item" + (i === selectedIndex ? " selected" : "");

      const nameSpan = document.createElement("span");
      nameSpan.className = "slash-autocomplete-name";
      nameSpan.textContent = "/" + cmd.name;
      item.appendChild(nameSpan);

      const descSpan = document.createElement("span");
      descSpan.className = "slash-autocomplete-desc";
      descSpan.textContent = cmd.description;
      item.appendChild(descSpan);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // Prevent blur
        selectCommand(cmd);
      });

      item.addEventListener("mouseenter", () => {
        selectedIndex = i;
        updateSelection();
      });

      autocompleteEl.appendChild(item);
    }
  }

  function updateSelection(): void {
    const items = autocompleteEl.querySelectorAll(".slash-autocomplete-item");
    items.forEach((el, i) => {
      el.classList.toggle("selected", i === selectedIndex);
    });
  }

  function selectCommand(cmd: SlashCommandDef): void {
    chatInput.value = "/" + cmd.name;
    hide();

    // Surface-specific commands (UI actions, platform features)
    switch (cmd.name) {
      case "clear":
        chatInput.value = "";
        callbacks.newConversation();
        return;
      case "settings":
        chatInput.value = "";
        callbacks.openSettings();
        return;
      case "conversations":
        chatInput.value = "";
        callbacks.openConversations();
        return;
      case "help":
        chatInput.value = "";
        callbacks.openShortcuts();
        return;
      case "memories":
        chatInput.value = "";
        callbacks.openMemory();
        return;
      case "skills":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:open-skills"));
        return;
      case "activity":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:open-activity"));
        return;
      case "goals":
      case "goal":
        chatInput.value = "";
        callbacks.openGoals();
        return;
      case "agents":
        chatInput.value = "";
        callbacks.openAgents();
        return;
      case "computer":
        chatInput.value = "";
        callbacks.toggleSlab();
        return;
      case "halt":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:halt"));
        return;
      case "resume":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:resume"));
        return;
      // Co-browse Slice 2b — sibling pattern of /halt /resume.
      // web-app.ts listens, calls coBrowseControl.* directly. The
      // machine rejects illegal transitions silently; the band's
      // next subscribe-emit reflects the truth (no chat-log spam
      // for wrong_party / invalid_from_state).
      case "grant":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:cobrowse-grant"));
        return;
      case "deny":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:cobrowse-deny"));
        return;
      case "reclaim":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:cobrowse-reclaim"));
        return;
      case "mcp": {
        chatInput.value = "";
        const servers = ctx.app.getMcpServers();
        if (servers.length === 0) {
          addMessage("system", "No MCP servers connected. Use Settings to add one.");
        } else {
          const lines = servers.map(
            (s) =>
              `${s.connected ? "●" : "○"} ${s.name} — ${s.url} (${s.toolCount} tools${s.trusted ? ", trusted" : ""})`,
          );
          addMessage("system", `MCP servers:\n${lines.join("\n")}`);
        }
        return;
      }
      case "export": {
        chatInput.value = "";
        void (async () => {
          const json = await ctx.app.exportData();
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `motebit-export-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          addMessage("system", "Export downloaded.");
        })();
        return;
      }
      case "forget": {
        chatInput.value = "";
        callbacks.openMemory();
        addMessage("system", "Use the memory panel to select memories to forget.");
        return;
      }
      case "serve": {
        chatInput.value = "";
        if (ctx.app.isServing()) {
          ctx.app.stopServing();
          addMessage("system", "Stopped serving");
        } else {
          void (async () => {
            const result = await ctx.app.startServing();
            if (result.ok) {
              addMessage("system", "Serving — accepting delegations while this tab is open");
            } else {
              addMessage("system", `Could not start serving: ${result.error}`);
            }
          })();
        }
        return;
      }
    }

    // /plan — decompose goal into steps and execute with auto-routing
    if (cmd.name === "plan") {
      // Leave the command in the input — user types the goal after it
      chatInput.value = "/plan ";
      chatInput.focus();
      return;
    }

    // Shared commands — same data extraction and formatting as all surfaces
    chatInput.value = "";
    void trySharedCommand(ctx, cmd.name, undefined, (flags) => callbacks.openMemory(flags));
  }

  // Listen to input changes
  chatInput.addEventListener("input", () => {
    const val = chatInput.value;
    if (val.startsWith("/") && val.length > 1) {
      const partial = val.slice(1);
      const cmds = filterCommands(partial);
      if (cmds.length > 0) {
        show(cmds);
      } else {
        hide();
      }
    } else if (val === "/") {
      show(SLASH_COMMANDS);
    } else {
      hide();
    }
  });

  // Arrow key navigation
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!visible) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % matches.length;
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
      updateSelection();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (matches[selectedIndex]) {
        selectCommand(matches[selectedIndex]!);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  // Hide on blur
  chatInput.addEventListener("blur", () => {
    // Small delay to allow mousedown on autocomplete items
    setTimeout(hide, 150);
  });

  return {
    tryExecute(text: string): boolean {
      if (!text.startsWith("/")) return false;
      const name = text.slice(1).split(/\s/)[0]!.toLowerCase();
      const cmd = SLASH_COMMANDS.find((c) => c.name === name);
      if (!cmd) return false;

      // Sensitivity is the first slash command on the web surface that
      // takes an inline arg. Handle it before the autocomplete-select
      // indirection (which discards args by overwriting chatInput.value).
      // User-facing entry point for the runtime sensitivity gate
      // shipped in 4ed47f42 (AI calls) + 98c12730 (outbound tools).
      if (name === "sensitivity") {
        chatInput.value = "";
        const arg = text.slice("/sensitivity".length).trim().toLowerCase();
        const VALID = ["none", "personal", "medical", "financial", "secret"] as const;
        const runtime = ctx.app.getRuntime();
        if (!runtime) {
          addMessage("system", "Runtime not initialized.");
          return true;
        }
        if (arg === "" || arg === "status") {
          addMessage("system", `Session sensitivity: ${runtime.getSessionSensitivity()}`);
          return true;
        }
        if (!(VALID as ReadonlyArray<string>).includes(arg)) {
          addMessage(
            "system",
            `Usage: /sensitivity [<level>] — level ∈ {${VALID.join(", ")}} (current: ${runtime.getSessionSensitivity()})`,
          );
          return true;
        }
        runtime.setSessionSensitivity(arg as import("@motebit/sdk").SensitivityLevel);
        const elevated = arg === "medical" || arg === "financial" || arg === "secret";
        addMessage(
          "system",
          elevated
            ? `Session elevated to ${arg} — outbound tools and external AI will fail-close until you switch to a sovereign (on-device) provider.`
            : `Session sensitivity: ${arg}`,
        );
        return true;
      }

      // /vision is the consent affordance for pixel passthrough to
      // external AI providers. Composes with sensitivity (medical/
      // financial/secret blocks regardless of consent) and provider
      // mode (sovereign on-device bypasses the gate entirely — bytes
      // never leave the device). Surface-determinism (#90): the AI
      // surfaces a `bytes_omitted: { reason: "consent_required" }`
      // directive; the user types `/vision grant` to authorize.
      // Doctrine: pixel-consent.ts.
      if (name === "vision") {
        chatInput.value = "";
        const arg = text.slice("/vision".length).trim().toLowerCase();
        const runtime = ctx.app.getRuntime();
        if (!runtime) {
          addMessage("system", "Runtime not initialized.");
          return true;
        }
        if (arg === "" || arg === "status") {
          const consent = runtime.getPixelConsent();
          const tier = runtime.getSessionSensitivity();
          // Compare via the string-literal cast — `SensitivityLevel`
          // is a TS enum on the sdk side; the BSL discriminant on
          // this surface is the string-literal projection. Same
          // pattern as the elevated-tier check inside the
          // `/sensitivity` arm (see VALID list above).
          const elevated = (tier as string) !== "none";
          addMessage(
            "system",
            elevated
              ? `Pixel passthrough: ${consent} (effective: blocked by session sensitivity "${tier}")`
              : `Pixel passthrough: ${consent}`,
          );
          return true;
        }
        if (arg === "grant") {
          runtime.setPixelConsent("session");
          addMessage(
            "system",
            "Pixel passthrough granted for this session when policy permits. Elevated sensitivity still blocks external pixel disclosure. Revoke with `/vision revoke`.",
          );
          return true;
        }
        if (arg === "revoke" || arg === "deny") {
          runtime.setPixelConsent("denied");
          addMessage(
            "system",
            "Pixel passthrough revoked. Motebit will not see screenshot bytes; it can still capture them for you to view.",
          );
          return true;
        }
        addMessage(
          "system",
          `Usage: /vision [grant|revoke|status] (current: ${runtime.getPixelConsent()})`,
        );
        return true;
      }

      // /receipts — show the user the trail of signed
      // ToolInvocationReceipts the runtime has been producing.
      // Closes the thesis line — "agents see, act, remember, and
      // collaborate through signed receipts instead of blind tool
      // calls" — by making the previously-invisible audit trail
      // visible on demand. Calm-software register: one line per
      // receipt, terse, monospace-friendly. No timestamps in
      // wall-clock since the relative-time format mirrors the
      // existing chat-message footer style.
      //
      // Future slices (receipts-2 in-chrome shimmer, receipts-3
      // permanent panel) read from the same `getRecentReceipts()`
      // getter; this slash command is the cheapest surface and
      // the discoverability anchor.
      if (name === "receipts") {
        chatInput.value = "";
        const arg = text.slice("/receipts".length).trim().toLowerCase();
        const runtime = ctx.app.getRuntime();
        if (!runtime) {
          addMessage("system", "Runtime not initialized.");
          return true;
        }
        const receipts = runtime.getRecentReceipts();
        if (receipts.length === 0) {
          addMessage(
            "system",
            "No signed receipts yet. Receipts are produced when motebit (or you) take actions through the runtime — try a tool call, then `/receipts` again.",
          );
          return true;
        }
        const requestedCount = arg === "" ? 10 : Math.max(1, Math.min(50, Number(arg) || 10));
        const slice = receipts.slice(-requestedCount);
        const lines = slice.map(formatReceiptLine);
        addMessage(
          "system",
          `Recent signed receipts (${slice.length} of ${receipts.length}):\n${lines.join("\n")}`,
        );
        return true;
      }

      chatInput.value = "/" + cmd.name;
      selectCommand(cmd);
      return true;
    },
  };
}

/**
 * Format a single signed `ToolInvocationReceipt` into a calm one-
 * line summary for `/receipts`. Apple-grade restraint: tool name,
 * status, relative time, signature prefix, status check. No
 * cryptographic verbosity in the visible line — the full receipt
 * (including the ed25519 signature, args/result hashes) lives in
 * the audit log; this is the at-a-glance "what motebit just
 * signed" view.
 *
 *   type_into        ✓  just now      sig:abc1…def9
 *   click_element    ✓  12 sec ago    sig:def4…ghi2
 *   navigate         ✓  1 min ago     sig:ghi5…jkl7
 *
 * Padded tool-name column for visual alignment in monospace; the
 * chat surface renders system messages in a similar register.
 */
function formatReceiptLine(
  receipt: import("@motebit/crypto").SignableToolInvocationReceipt,
): string {
  const status = receipt.status === "completed" ? "✓" : receipt.status === "failed" ? "✗" : "⊘";
  const ago = relativeTime(receipt.completed_at);
  // Signature is base64; show first 4 + last 4 chars for at-a-
  // glance identity without the full 88-char string.
  const sig = receipt.signature;
  const sigPrefix = sig.length > 12 ? `${sig.slice(0, 4)}…${sig.slice(-4)}` : sig;
  return `${receipt.tool_name.padEnd(16)} ${status}  ${ago.padEnd(12)} sig:${sigPrefix}`;
}

function relativeTime(unixMs: number): string {
  const delta = Date.now() - unixMs;
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)} sec ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return `${Math.floor(delta / 86_400_000)} day ago`;
}
