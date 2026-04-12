/**
 * `usePairing` — React hook that owns the cross-device pairing flow
 * state and handlers for the mobile App.
 *
 * Owns:
 *
 *   - 8 useState slots (modal visibility, mode, code, input buffers,
 *     status text, pairing id, claim name, sync url input)
 *   - 2 useRef slots (poll interval handle, sync url ref for approve/deny)
 *   - The polling effect cleanup
 *
 * Returns:
 *
 *   - Modal display props (`showPairing`, `pairingMode`, `pairingCode`, …)
 *   - Controlled input setters (`setPairingCodeInput`, `setPairingSyncUrlInput`)
 *   - 6 handler callbacks (initiate, connect, claim, approve, deny, close)
 *
 * ### Flow
 *
 * Device A (existing): `handleInitiatePairing()` shows the modal in
 * "initiate" mode. User enters a relay URL and taps Connect →
 * `handleInitiateConnect()` calls `app.initiatePairing()` to mint a
 * 6-char code, displays it, and starts polling for a claim. When a
 * claim arrives, the status text invites approval →
 * `handlePairingApprove()` calls `app.approvePairing()` and closes.
 *
 * Device B (new): User opens the pairing modal in "claim" mode, enters
 * the 6-char code and relay URL, taps Claim →
 * `handlePairingClaimSubmit()` calls `app.claimPairing()` and starts
 * polling for approval. When approval arrives, calls
 * `app.completePairing()` to pin the motebit_id, then runs the
 * onPaired callback so App.tsx can initAI + subscribe + startSync +
 * setInitialized.
 *
 * ### Why a hook
 *
 * Because all pairing state is component-local and the handlers need
 * stable closures for the modal JSX. A pure function wouldn't capture
 * the state setters cleanly. The hook is ~180 lines of consolidated
 * pairing logic that App.tsx can drop in and forget.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_MOTEBIT_CLOUD_URL } from "@motebit/sdk";
import type { MobileApp } from "./mobile-app";
import { ASYNC_STORAGE_KEYS } from "./storage-keys";

function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export interface UsePairingDeps {
  app: MobileApp;
  addSystemMessage: (content: string) => void;
  setShowSettings: (show: boolean) => void;
  /**
   * Called on Device B after successful completePairing. Gives App.tsx
   * a hook to run its post-pair bootstrap: initAI, subscribeToState,
   * start, wire sync status, startSync, setInitialized.
   */
  onPaired: (syncUrl: string) => Promise<void>;
}

export interface UsePairingResult {
  // Modal state
  showPairing: boolean;
  pairingMode: "initiate" | "claim";
  pairingCode: string;
  pairingCodeInput: string;
  pairingStatus: string;
  pairingId: string | null;
  pairingClaimName: string;
  pairingSyncUrlInput: string;

  // Controlled setters for modal inputs
  setPairingCodeInput: (v: string) => void;
  setPairingSyncUrlInput: (v: string) => void;

  // Handlers
  handleInitiatePairing: () => void;
  handleInitiateConnect: () => Promise<void>;
  handlePairingClaimSubmit: () => Promise<void>;
  handlePairingApprove: () => Promise<void>;
  handlePairingDeny: () => Promise<void>;
  closePairingDialog: () => void;
}

export function usePairing(deps: UsePairingDeps): UsePairingResult {
  const { app, addSystemMessage, setShowSettings, onPaired } = deps;

  const [showPairing, setShowPairing] = useState(false);
  const [pairingMode, setPairingMode] = useState<"initiate" | "claim">("claim");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingStatus, setPairingStatusText] = useState("");
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [pairingClaimName, setPairingClaimName] = useState("");
  const [pairingSyncUrlInput, setPairingSyncUrlInput] = useState(DEFAULT_MOTEBIT_CLOUD_URL);
  const defaultSyncUrlRef = useRef(DEFAULT_MOTEBIT_CLOUD_URL);
  const pairingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairingSyncUrlRef = useRef("");

  useEffect(() => {
    void AsyncStorage.getItem(ASYNC_STORAGE_KEYS.relayUrl).then((saved) => {
      if (saved != null && saved !== "") {
        defaultSyncUrlRef.current = saved;
        setPairingSyncUrlInput(saved);
      }
    });
  }, []);
  /** Held between claim and complete — ephemeral X25519 private key for identity key transfer. */
  const ephemeralKeyRef = useRef<Uint8Array | null>(null);
  const claimCodeRef = useRef("");

  const stopPairingPoll = useCallback(() => {
    if (pairingPollRef.current) {
      clearInterval(pairingPollRef.current);
      pairingPollRef.current = null;
    }
  }, []);

  const closePairingDialog = useCallback(() => {
    stopPairingPoll();
    setShowPairing(false);
    setPairingId(null);
    setPairingCode("");
    setPairingCodeInput("");
    setPairingClaimName("");
    setPairingSyncUrlInput(defaultSyncUrlRef.current);
  }, [stopPairingPoll]);

  // Device A: initiate from settings — show pairing modal with sync URL input
  const handleInitiatePairing = useCallback(() => {
    setPairingMode("initiate");
    setPairingSyncUrlInput(defaultSyncUrlRef.current);
    setPairingStatusText("");
    setShowSettings(false);
    setShowPairing(true);
  }, [setShowSettings]);

  // Device A: after entering sync URL, generate pairing code
  const handleInitiateConnect = useCallback(async () => {
    const url = normalizeRelayUrl(pairingSyncUrlInput);
    if (!url) {
      setPairingStatusText("Relay URL is required");
      return;
    }
    setPairingSyncUrlInput(url);
    pairingSyncUrlRef.current = url;
    setPairingStatusText("Generating code...");
    try {
      const { pairingCode: code, pairingId: pid } = await app.initiatePairing(url);
      setPairingCode(code);
      setPairingId(pid);
      setPairingStatusText("Enter this code on the other device");

      // Poll for claim
      pairingPollRef.current = setInterval(() => {
        void (async () => {
          try {
            const session = await app.getPairingSession(url, pid);
            if (session.status === "claimed") {
              stopPairingPoll();
              setPairingClaimName(session.claiming_device_name ?? "Unknown device");
              setPairingStatusText(`"${session.claiming_device_name}" wants to join`);
            }
          } catch {
            // Non-fatal
          }
        })();
      }, 2000);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingSyncUrlInput, app, stopPairingPoll]);

  // Device B: submit claim code
  const handlePairingClaimSubmit = useCallback(async () => {
    const code = pairingCodeInput.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingStatusText("Code must be 6 characters");
      return;
    }

    const syncUrl = normalizeRelayUrl(pairingSyncUrlInput);
    if (!syncUrl) {
      setPairingStatusText("Relay URL is required");
      return;
    }

    setPairingSyncUrlInput(syncUrl);
    pairingSyncUrlRef.current = syncUrl;
    setPairingStatusText("Claiming...");
    try {
      const { pairingId: pid, ephemeralPrivateKey } = await app.claimPairing(syncUrl, code);
      ephemeralKeyRef.current = ephemeralPrivateKey;
      claimCodeRef.current = code;
      setPairingId(pid);
      setPairingStatusText("Waiting for approval...");

      // Poll for approval
      pairingPollRef.current = setInterval(() => {
        void (async () => {
          try {
            const status = await app.pollPairingStatus(syncUrl, pid);
            if (
              status.status === "approved" &&
              status.device_id != null &&
              status.device_id !== "" &&
              status.motebit_id != null &&
              status.motebit_id !== ""
            ) {
              stopPairingPoll();
              const walletWarning = await app.completePairing(
                {
                  motebitId: status.motebit_id,
                  deviceId: status.device_id,
                },
                syncUrl,
                status.key_transfer && ephemeralKeyRef.current
                  ? {
                      keyTransfer: status.key_transfer,
                      ephemeralPrivateKey: ephemeralKeyRef.current,
                      pairingCode: claimCodeRef.current,
                      pairingId: pid,
                    }
                  : undefined,
              );
              ephemeralKeyRef.current = null;
              closePairingDialog();
              addSystemMessage(walletWarning ?? "Linked to existing motebit");

              // Run the caller's post-pair bootstrap
              await onPaired(syncUrl);
            } else if (status.status === "denied") {
              stopPairingPoll();
              setPairingStatusText("Pairing was denied by the other device");
            }
          } catch {
            // Non-fatal
          }
        })();
      }, 2000);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [
    pairingCodeInput,
    pairingSyncUrlInput,
    app,
    stopPairingPoll,
    closePairingDialog,
    addSystemMessage,
    onPaired,
  ]);

  // Device A: approve
  const handlePairingApprove = useCallback(async () => {
    if (pairingId == null || pairingId === "") return;
    const syncUrl = pairingSyncUrlRef.current;
    setPairingStatusText("Approving...");
    try {
      const result = await app.approvePairing(syncUrl, pairingId);
      closePairingDialog();
      addSystemMessage(`Device linked (${result.deviceId.slice(0, 8)}...)`);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingId, app, closePairingDialog, addSystemMessage]);

  // Device A: deny
  const handlePairingDeny = useCallback(async () => {
    if (pairingId == null || pairingId === "") return;
    const syncUrl = pairingSyncUrlRef.current;
    try {
      await app.denyPairing(syncUrl, pairingId);
      closePairingDialog();
      addSystemMessage("Pairing denied");
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingId, app, closePairingDialog, addSystemMessage]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPairingPoll();
  }, [stopPairingPoll]);

  return {
    showPairing,
    pairingMode,
    pairingCode,
    pairingCodeInput,
    pairingStatus,
    pairingId,
    pairingClaimName,
    pairingSyncUrlInput,
    setPairingCodeInput,
    setPairingSyncUrlInput,
    handleInitiatePairing,
    handleInitiateConnect,
    handlePairingClaimSubmit,
    handlePairingApprove,
    handlePairingDeny,
    closePairingDialog,
  };
}
