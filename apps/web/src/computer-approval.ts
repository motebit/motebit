/**
 * Web computer-use approval wrapper — thin web binding for the
 * runtime-shared `createComputerApprovalFlow` factory.
 *
 * The factory + DOM-shape contract live in `@motebit/runtime`
 * (`packages/runtime/src/computer-approval-shared.ts`); web's job is
 * just to point it at the chat-log element. The CSS for
 * `.approval-card` is already declared in `apps/web/index.html` so
 * the rendered card matches the existing tool-approval primitive
 * visually — same audit-trail-in-chat-log discipline as desktop.
 *
 * Fail-closed: if the chat log isn't mounted (which would only happen
 * during very-early boot before the DOM is ready), the factory's
 * caller receives a no-renderHost flow that denies every action. The
 * same guard the runtime factory enforces.
 */

import { createComputerApprovalFlow as createSharedFlow } from "@motebit/runtime";
import type { ComputerApprovalFlow } from "@motebit/runtime";

export function createWebComputerApprovalFlow(): ComputerApprovalFlow {
  const chatLog = typeof document !== "undefined" ? document.getElementById("chat-log") : null;
  return createSharedFlow({ renderHost: chatLog ?? undefined });
}
