import { motebitCloudPickerModels } from "@motebit/sdk";

/**
 * Render the `#cloud-model` rows from `@motebit/sdk` (#654 cold review):
 * the `auto` row index.html ships, then `motebitCloudPickerModels()` — the
 * same list desktop offers. index.html carries no model ids, so the rows
 * can only come from the sdk.
 */
export function renderCloudModelPicker(select: HTMLSelectElement): void {
  const auto = Array.from(select.options).find((o) => o.value === "auto");
  select.replaceChildren();
  if (auto) select.appendChild(auto);
  for (const id of motebitCloudPickerModels()) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }
}

/**
 * Restore a stored Motebit Cloud model into the `#cloud-model` select
 * without rewriting it (#654 cold review R2). Assigning `select.value` to an
 * id that has no `<option>` leaves NOTHING selected (`value === ""`), so a
 * stored Cloud id outside the rendered list — which the proxy serves — was persisted as an
 * empty model on the next Save. A stored id is shown as its own selected
 * row, like the Anthropic picker's stored row; it is never migrated. The
 * BYOK OpenAI / Google / Groq / DeepSeek selects restore through the same
 * function (a stored `gemma-*` on Google was dropped the same way).
 */
export function selectStoredModel(select: HTMLSelectElement, stored?: string | null): void {
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

/** The Cloud select's restore; the same rule serves the BYOK vendor selects. */
export const selectStoredCloudModel = selectStoredModel;
