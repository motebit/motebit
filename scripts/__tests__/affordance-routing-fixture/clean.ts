/**
 * FIXTURE — sanctioned surface-determinism pattern.
 *
 * The chip-tap handler calls `invokeCapability(name, args)` directly. No
 * constructed prompt, no `handleSend` call in the routing path. Asserts the
 * gate does NOT flag this file.
 */

interface App {
  invokeCapability(capability: string, args: string): unknown;
}

export function onChipClick(app: App, url: string): void {
  void app.invokeCapability("review_pr", url);
}
