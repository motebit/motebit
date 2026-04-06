/**
 * Pairing UI — multi-device linking dialog for the web app.
 *
 * Two flows:
 *   Device A ("Link Device"): generates a 6-char code, waits for Device B to claim,
 *     then shows approve/deny when B arrives.
 *   Device B ("Claim Device"): enters the 6-char code from Device A, waits for approval.
 *
 * Both flows poll the relay every 2 seconds until resolved or cancelled.
 */
import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";

const POLL_INTERVAL_MS = 2000;

// DOM elements
const backdrop = document.getElementById("pairing-backdrop") as HTMLDivElement;
const title = document.getElementById("pairing-title") as HTMLDivElement;
const urlRow = document.getElementById("pairing-url-row") as HTMLDivElement;
const relayUrlInput = document.getElementById("pairing-relay-url") as HTMLInputElement;
const codeDisplay = document.getElementById("pairing-code-display") as HTMLDivElement;
const inputRow = document.getElementById("pairing-input-row") as HTMLDivElement;
const codeInput = document.getElementById("pairing-code-input") as HTMLInputElement;
const claimInfo = document.getElementById("pairing-claim-info") as HTMLDivElement;
const status = document.getElementById("pairing-status") as HTMLDivElement;
const actions = document.getElementById("pairing-actions") as HTMLDivElement;
const cancelBtn = document.getElementById("pairing-cancel") as HTMLButtonElement;

let pollTimer: ReturnType<typeof setInterval> | null = null;

function show(): void {
  backdrop.style.display = "flex";
}

function hide(): void {
  backdrop.style.display = "none";
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function reset(): void {
  codeDisplay.style.display = "none";
  codeDisplay.textContent = "";
  inputRow.style.display = "none";
  codeInput.value = "";
  claimInfo.style.display = "none";
  claimInfo.textContent = "";
  status.textContent = "";
  urlRow.style.display = "block";
  // Reset actions to just cancel
  actions.innerHTML = "";
  actions.appendChild(cancelBtn);
}

function setStatus(text: string): void {
  status.textContent = text;
}

function getSyncUrl(): string {
  return relayUrlInput.value.trim() || loadSyncUrl() || "";
}

export function initPairing(_ctx: WebContext): void {
  // Pre-fill relay URL if saved
  const saved = loadSyncUrl();
  if (saved) relayUrlInput.value = saved;

  cancelBtn.addEventListener("click", () => {
    hide();
    reset();
  });

  // Close on backdrop click (outside dialog)
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      hide();
      reset();
    }
  });
}

/** Device A: generate code, wait for claim, approve/deny. */
export function startLinkDevice(ctx: WebContext): void {
  reset();
  title.textContent = "Link Another Device";
  show();

  // Show connect button
  const connectBtn = document.createElement("button");
  connectBtn.className = "settings-outline-btn";
  connectBtn.style.flex = "1";
  connectBtn.textContent = "Generate Code";
  actions.insertBefore(connectBtn, cancelBtn);

  connectBtn.addEventListener("click", () => {
    const url = getSyncUrl();
    if (!url) {
      setStatus("Enter a relay URL");
      return;
    }
    connectBtn.disabled = true;
    setStatus("Generating code...");
    urlRow.style.display = "none";

    void (async () => {
      try {
        const { pairingCode, pairingId } = await ctx.app.initiatePairing(url);
        codeDisplay.textContent = pairingCode;
        codeDisplay.style.display = "block";
        connectBtn.remove();
        setStatus("Show this code on the other device");

        // Poll for claim
        pollTimer = setInterval(() => {
          void (async () => {
            try {
              const session = await ctx.app.getPairingSession(url, pairingId);
              if (session.status === "claimed") {
                if (pollTimer) {
                  clearInterval(pollTimer);
                  pollTimer = null;
                }
                const name = session.claiming_device_name ?? "Unknown device";
                claimInfo.textContent = `"${name}" wants to join`;
                claimInfo.style.display = "block";
                setStatus("");

                // Show approve/deny buttons
                const denyBtn = document.createElement("button");
                denyBtn.className = "settings-outline-btn";
                denyBtn.style.flex = "1";
                denyBtn.textContent = "Deny";

                const approveBtn = document.createElement("button");
                approveBtn.className = "settings-outline-btn";
                approveBtn.style.flex = "1";
                approveBtn.style.background = "var(--text-accent, #6366f1)";
                approveBtn.style.color = "#fff";
                approveBtn.style.borderColor = "transparent";
                approveBtn.textContent = "Approve";

                // Clear and rebuild actions
                actions.innerHTML = "";
                actions.appendChild(denyBtn);
                actions.appendChild(approveBtn);

                denyBtn.addEventListener("click", () => {
                  void ctx.app.denyPairing(url, pairingId).catch(() => {});
                  ctx.showToast("Pairing denied");
                  hide();
                  reset();
                });

                approveBtn.addEventListener("click", () => {
                  approveBtn.disabled = true;
                  denyBtn.disabled = true;
                  setStatus("Approving...");
                  void (async () => {
                    try {
                      const result = await ctx.app.approvePairing(url, pairingId);
                      ctx.showToast(`Device linked: ${result.deviceId.slice(0, 8)}...`);
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      ctx.showToast(`Approve failed: ${msg}`);
                    }
                    hide();
                    reset();
                  })();
                });
              }
            } catch {
              // Poll error — keep trying
            }
          })();
        }, POLL_INTERVAL_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Failed: ${msg}`);
        connectBtn.disabled = false;
        urlRow.style.display = "block";
      }
    })();
  });
}

/** Device B: enter code, wait for approval. */
export function startClaimDevice(ctx: WebContext): void {
  reset();
  title.textContent = "Link Existing Motebit";
  inputRow.style.display = "block";
  show();
  codeInput.focus();

  const submitBtn = document.createElement("button");
  submitBtn.className = "settings-outline-btn";
  submitBtn.style.flex = "1";
  submitBtn.textContent = "Submit";
  actions.insertBefore(submitBtn, cancelBtn);

  function submit(): void {
    const code = codeInput.value.trim();
    if (code.length !== 6) {
      setStatus("Enter the 6-character code");
      return;
    }
    const url = getSyncUrl();
    if (!url) {
      setStatus("Enter a relay URL");
      return;
    }
    submitBtn.disabled = true;
    codeInput.disabled = true;
    setStatus("Claiming...");

    void (async () => {
      try {
        const { pairingId } = await ctx.app.claimPairing(url, code);
        inputRow.style.display = "none";
        urlRow.style.display = "none";
        submitBtn.remove();
        setStatus("Waiting for approval from the other device...");

        // Poll for approval
        pollTimer = setInterval(() => {
          void (async () => {
            try {
              const result = await ctx.app.pollPairingStatus(url, pairingId);
              if (result.status === "approved" && result.device_id && result.motebit_id) {
                if (pollTimer) {
                  clearInterval(pollTimer);
                  pollTimer = null;
                }
                setStatus("Approved! Starting sync...");
                try {
                  await ctx.app.startSync(url);
                } catch {
                  // Sync start failure is non-fatal for pairing
                }
                ctx.showToast("Device paired successfully");
                hide();
                reset();
              } else if (result.status === "denied") {
                if (pollTimer) {
                  clearInterval(pollTimer);
                  pollTimer = null;
                }
                setStatus("Pairing was denied by the other device");
              }
            } catch {
              // Poll error — keep trying
            }
          })();
        }, POLL_INTERVAL_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Failed: ${msg}`);
        submitBtn.disabled = false;
        codeInput.disabled = false;
      }
    })();
  }

  submitBtn.addEventListener("click", submit);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}
