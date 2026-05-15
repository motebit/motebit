/**
 * Identity-divergence banner — desktop. Sibling of
 * apps/web/src/ui/divergence-banner.ts (same visual surface, same
 * three CTAs). See the web sibling for the doctrine + behavior
 * citation graph.
 */

import type { RestoreIdentityAPI } from "./restore-identity";
import type { DesktopContext } from "../types";

export function initDivergenceBanner(ctx: DesktopContext, restore: RestoreIdentityAPI): void {
  const banner = document.getElementById("divergence-banner") as HTMLDivElement | null;
  const motebitIdEl = document.getElementById("divergence-banner-motebit-id");
  const restoreMdBtn = document.getElementById("divergence-restore-md") as HTMLButtonElement | null;
  const restoreSeedBtn = document.getElementById(
    "divergence-restore-seed",
  ) as HTMLButtonElement | null;
  const dismissBtn = document.getElementById("divergence-dismiss") as HTMLButtonElement | null;

  if (!banner || !motebitIdEl || !restoreMdBtn || !restoreSeedBtn || !dismissBtn) return;

  const diverged = ctx.app.divergedFromMotebitId;
  if (diverged === null) return;

  motebitIdEl.textContent = `motebit·${diverged.slice(0, 12)}…`;
  motebitIdEl.title = diverged;
  banner.style.display = "";

  function hideBanner(): void {
    banner!.style.display = "none";
    ctx.app.clearDivergenceNotice();
  }

  restoreMdBtn.addEventListener("click", () => {
    restore.openFromFile();
  });

  restoreSeedBtn.addEventListener("click", () => {
    restore.openFromSeed();
  });

  dismissBtn.addEventListener("click", hideBanner);
}
