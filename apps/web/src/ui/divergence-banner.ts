/**
 * Identity-divergence banner — web. Renders the recovery banner when
 * bootstrap detected the divergent-state case (`configStore` claimed an
 * identity but `keyStore.hasPrivateKey()` came back empty). Banner
 * surfaces three CTAs:
 *
 *   - "Restore from motebit.md…" → opens the restore-identity modal
 *     in file mode (commit 3 of the restore-from-backup arc)
 *   - "Restore from seed…" → opens the restore-identity modal in seed
 *     mode (commit 4)
 *   - "Dismiss" → calls `app.clearDivergenceNotice()` to accept the
 *     auto-recovered fresh identity (the silent re-mint behavior the
 *     system had pre-this-arc, now opted-in instead of default)
 *
 * The banner is the second leg of the keystore-probe-re-exposure arc
 * per [[feedback_sovereignty_primitives_audit_consumers]]: it makes
 * the divergence signal user-actionable. Without this banner, the
 * `divergedFromMotebitId` field on `BootstrapResult` would be observed
 * by nothing on the web surface and the user would see the same
 * silent-re-mint UX that motivated the original probe revert.
 *
 * Sibling-boundary doctrine: desktop has the same banner shape (see
 * apps/desktop/src/ui/divergence-banner.ts). Mobile uses an Alert
 * (the OS-native banner-shaped surface for React Native) and lives
 * inline in apps/mobile/src/App.tsx.
 */

import type { RestoreIdentityAPI } from "./restore-identity";
import type { WebContext } from "../types";

export function initDivergenceBanner(ctx: WebContext, restore: RestoreIdentityAPI): void {
  const banner = document.getElementById("divergence-banner") as HTMLDivElement | null;
  const motebitIdEl = document.getElementById("divergence-banner-motebit-id");
  const restoreMdBtn = document.getElementById("divergence-restore-md") as HTMLButtonElement | null;
  const restoreSeedBtn = document.getElementById(
    "divergence-restore-seed",
  ) as HTMLButtonElement | null;
  const dismissBtn = document.getElementById("divergence-dismiss") as HTMLButtonElement | null;

  if (!banner || !motebitIdEl || !restoreMdBtn || !restoreSeedBtn || !dismissBtn) return;

  const diverged = ctx.app.divergedFromMotebitId;
  if (diverged === null) return; // no divergence — banner stays hidden

  // Truncate the orphaned motebit_id for display. The user can hover
  // the <code> element to see the full id via title attribute.
  motebitIdEl.textContent = `motebit·${diverged.slice(0, 12)}…`;
  motebitIdEl.title = diverged;
  banner.style.display = "";

  function hideBanner(): void {
    banner!.style.display = "none";
    ctx.app.clearDivergenceNotice();
  }

  restoreMdBtn.addEventListener("click", () => {
    // Restore from .md replaces the just-minted fresh identity with
    // the user's prior one. The banner stays visible until the modal
    // closes; on successful restore the page reloads so the banner
    // is gone with the rest of the post-restore reset.
    restore.openFromFile();
  });

  restoreSeedBtn.addEventListener("click", () => {
    restore.openFromSeed();
  });

  dismissBtn.addEventListener("click", hideBanner);
}
