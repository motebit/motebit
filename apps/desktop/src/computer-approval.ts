/**
 * Desktop computer-use approval flow — re-export of the surface-shared
 * factory that now lives in `@motebit/runtime`.
 *
 * The factory used to live here when desktop was the only surface;
 * lifting it up was the slice-3 refactor (web also needs it). The
 * factory's DOM-shape interface is identical between desktop's Tauri
 * webview and web's Vite bundle — both consume the same primitive,
 * each passing its own `renderHost` (typically the chat-log element).
 *
 * This file stays as a re-export so existing test imports
 * (`../computer-approval.js`) keep working without churn.
 */

export {
  createComputerApprovalFlow,
  type ApprovalRenderHost,
  type CreateComputerApprovalFlowOptions,
} from "@motebit/runtime";
