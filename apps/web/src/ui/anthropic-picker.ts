/**
 * Web's Anthropic BYOK model picker (#654). The rows are the sdk's
 * `ANTHROPIC_PICKER` — never an option list copied into index.html — so a
 * new Claude model reaches this surface by editing one table. A stored model
 * that isn't a picker row (a pre-#654 default, a typed id outside the
 * picker) is shown as its own selected row and never migrated.
 */
import { pickerOptionsWithStored } from "@motebit/sdk";

export function renderAnthropicPicker(select: HTMLSelectElement, stored?: string | null): void {
  select.innerHTML = "";
  for (const row of pickerOptionsWithStored(stored)) {
    const opt = document.createElement("option");
    opt.value = row.id;
    opt.textContent = row.label;
    if (row.selected) opt.selected = true;
    select.appendChild(opt);
  }
}
