/**
 * FIXTURE — deliberate violation of the surface-determinism gate.
 *
 * Asserts that `check-affordance-routing` flags a UI handler that builds a
 * capability-naming prompt and routes it through the AI-loop entry point
 * (`handleSend`) rather than calling `invokeCapability` directly.
 *
 * This file is intentionally broken. It is scanned only via the `--fixture`
 * flag on the gate. The gate's real scan excludes `__tests__/` so this file
 * never fails the production check.
 */

declare function handleSend(text: string): void;

export function onChipClick(url: string): void {
  // Anti-pattern: constructing a delegation prompt in natural language and
  // sending it through the AI loop. The `required_capabilities` literal is
  // the sharpest signal — any handler that names it inline is trying to
  // steer the model, which is the drift the gate forbids.
  handleSend(
    `Delegate this code review to a remote agent on the motebit network ` +
      `(required_capabilities: ["review_pr"]). Pull request: ${url}`,
  );
}
