/**
 * Restore a stored Motebit Cloud model into the `#cloud-model` select
 * without rewriting it (#654 cold review R2). Assigning `select.value` to an
 * id that has no `<option>` leaves NOTHING selected (`value === ""`), so a
 * stored Cloud id outside the hard-coded list — which the proxy serves — was persisted as an
 * empty model on the next Save. A stored id is shown as its own selected
 * row, like the Anthropic picker's stored row; it is never migrated.
 */
export function selectStoredCloudModel(select: HTMLSelectElement, stored?: string | null): void {
  if (stored == null || stored === "") return;
  const has = Array.from(select.options).some((o) => o.value === stored);
  if (!has) {
    const opt = document.createElement("option");
    opt.value = stored;
    opt.textContent = stored;
    select.insertBefore(opt, select.firstChild);
  }
  select.value = stored;
}
