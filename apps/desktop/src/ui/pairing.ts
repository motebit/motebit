import type { InvokeFn, PairingSession } from "../index";
import type { DesktopContext } from "../types";

// === DOM Refs ===

const pairingBackdrop = document.getElementById("pairing-backdrop") as HTMLDivElement;
const pairingTitle = document.getElementById("pairing-title") as HTMLDivElement;
const pairingCodeDisplay = document.getElementById("pairing-code-display") as HTMLDivElement;
const pairingInputRow = document.getElementById("pairing-input-row") as HTMLDivElement;
const pairingCodeInput = document.getElementById("pairing-code-input") as HTMLInputElement;
const pairingClaimInfo = document.getElementById("pairing-claim-info") as HTMLDivElement;
const pairingStatus = document.getElementById("pairing-status") as HTMLDivElement;
const pairingActions = document.getElementById("pairing-actions") as HTMLDivElement;

// === Pairing State ===

let pairingPollTimer: ReturnType<typeof setInterval> | null = null;

// === Pairing API ===

export interface PairingAPI {
  close(): void;
  startLinkDevice(invoke: InvokeFn, syncUrl: string): void;
  startClaim(invoke: InvokeFn, syncUrl: string): void;
}

export function initPairing(ctx: DesktopContext): PairingAPI {
  function close(): void {
    pairingBackdrop.classList.remove("open");
    if (pairingPollTimer) {
      clearInterval(pairingPollTimer);
      pairingPollTimer = null;
    }
  }

  function resetDialog(): void {
    pairingCodeDisplay.style.display = "none";
    pairingCodeDisplay.textContent = "";
    pairingInputRow.style.display = "none";
    pairingCodeInput.value = "";
    pairingClaimInfo.style.display = "none";
    pairingClaimInfo.textContent = "";
    pairingStatus.textContent = "";
    pairingActions.innerHTML =
      '<button class="pairing-btn-cancel" id="pairing-cancel">Cancel</button>';
    document.getElementById("pairing-cancel")!.addEventListener("click", close);
  }

  // Device A: "Link Another Device"
  function startLinkDevice(invoke: InvokeFn, syncUrl: string): void {
    resetDialog();
    pairingTitle.textContent = "Link Another Device";
    pairingStatus.textContent = "Generating code...";
    pairingBackdrop.classList.add("open");

    void (async () => {
      try {
        const { pairingCode, pairingId } = await ctx.app.initiatePairing(invoke, syncUrl);

        pairingCodeDisplay.textContent = pairingCode;
        pairingCodeDisplay.style.display = "block";
        pairingStatus.textContent = "Enter this code on the other device";

        pairingPollTimer = setInterval(() => {
          void pollForClaim(invoke, syncUrl, pairingId);
        }, 2000);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        pairingStatus.textContent = `Error: ${msg}`;
      }
    })();
  }

  async function pollForClaim(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<void> {
    try {
      const session: PairingSession = await ctx.app.getPairingSession(invoke, syncUrl, pairingId);

      if (session.status === "claimed") {
        if (pairingPollTimer) {
          clearInterval(pairingPollTimer);
          pairingPollTimer = null;
        }

        pairingCodeDisplay.style.display = "none";
        pairingClaimInfo.style.display = "block";
        pairingClaimInfo.textContent = `"${session.claiming_device_name}" wants to join`;
        pairingStatus.textContent = "";

        pairingActions.innerHTML = "";
        const denyBtn = document.createElement("button");
        denyBtn.className = "pairing-btn-deny";
        denyBtn.textContent = "Deny";
        denyBtn.addEventListener("click", () => {
          void (async () => {
            try {
              await ctx.app.denyPairing(invoke, syncUrl, pairingId);
              close();
              ctx.showToast("Pairing denied");
            } catch (err: unknown) {
              pairingStatus.textContent = err instanceof Error ? err.message : String(err);
            }
          })();
        });

        const approveBtn = document.createElement("button");
        approveBtn.className = "pairing-btn-approve";
        approveBtn.textContent = "Approve";
        approveBtn.addEventListener("click", () => {
          void (async () => {
            try {
              approveBtn.disabled = true;
              denyBtn.disabled = true;
              pairingStatus.textContent = "Approving...";
              const result = await ctx.app.approvePairing(invoke, syncUrl, pairingId);
              void ctx.app.startSync(invoke, syncUrl).catch(() => {});
              close();
              ctx.showToast(`Device linked (${result.deviceId.slice(0, 8)}...)`);
            } catch (err: unknown) {
              pairingStatus.textContent = err instanceof Error ? err.message : String(err);
              approveBtn.disabled = false;
              denyBtn.disabled = false;
            }
          })();
        });

        pairingActions.appendChild(denyBtn);
        pairingActions.appendChild(approveBtn);
      }
    } catch {
      // Polling errors are non-fatal
    }
  }

  // Device B: "I have an existing motebit"
  function startClaim(invoke: InvokeFn, syncUrl: string): void {
    resetDialog();
    pairingTitle.textContent = "Link Existing Motebit";
    pairingInputRow.style.display = "block";
    pairingStatus.textContent = "Enter the code from your other device";

    const submitBtn = document.createElement("button");
    submitBtn.className = "pairing-btn-approve";
    submitBtn.textContent = "Submit";

    pairingActions.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "pairing-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);

    submitBtn.addEventListener("click", () => {
      const code = pairingCodeInput.value.trim().toUpperCase();
      if (code.length !== 6) {
        pairingStatus.textContent = "Code must be 6 characters";
        return;
      }
      void handlePairingClaim(invoke, syncUrl, code);
    });

    pairingCodeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitBtn.click();
    });

    pairingActions.appendChild(cancelBtn);
    pairingActions.appendChild(submitBtn);
    pairingBackdrop.classList.add("open");
    pairingCodeInput.focus();
  }

  async function handlePairingClaim(
    invoke: InvokeFn,
    syncUrl: string,
    code: string,
  ): Promise<void> {
    pairingStatus.textContent = "Claiming...";
    pairingInputRow.style.display = "none";

    try {
      const { pairingId } = await ctx.app.claimPairing(syncUrl, code);
      pairingStatus.textContent = "Waiting for approval...";

      pairingActions.innerHTML = "";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "pairing-btn-cancel";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", close);
      pairingActions.appendChild(cancelBtn);

      pairingPollTimer = setInterval(() => {
        void (async () => {
          try {
            const status = await ctx.app.pollPairingStatus(syncUrl, pairingId);
            if (
              status.status === "approved" &&
              status.device_id != null &&
              status.device_id !== "" &&
              status.motebit_id != null &&
              status.motebit_id !== ""
            ) {
              if (pairingPollTimer) {
                clearInterval(pairingPollTimer);
                pairingPollTimer = null;
              }
              await ctx.app.completePairing(invoke, {
                motebitId: status.motebit_id,
                deviceId: status.device_id,
              });
              void ctx.app.startSync(invoke, syncUrl).catch(() => {});
              close();
              const welcomeBackdrop = document.getElementById("welcome-backdrop") as HTMLDivElement;
              welcomeBackdrop.classList.remove("open");
              ctx.showToast("Linked to existing motebit");
            } else if (status.status === "denied") {
              if (pairingPollTimer) {
                clearInterval(pairingPollTimer);
                pairingPollTimer = null;
              }
              pairingStatus.textContent = "Pairing was denied by the other device";
            }
          } catch {
            // Polling errors are non-fatal
          }
        })();
      }, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pairingStatus.textContent = `Error: ${msg}`;
      pairingInputRow.style.display = "block";
    }
  }

  // Initial cancel button
  document.getElementById("pairing-cancel")!.addEventListener("click", close);

  return { close, startLinkDevice, startClaim };
}
