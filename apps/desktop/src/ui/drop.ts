/**
 * Drop handlers — DOM drag-drop → typed `feedPerception` payload.
 *
 * Sibling of `apps/web/src/ui/drop.ts`. Tauri renders the desktop
 * surface in a Chromium webview, so the DOM `DataTransfer` API is
 * identical to the browser path; the implementation mirrors the web
 * shape on purpose. Per the sibling-boundary rule
 * (CLAUDE.md): when one surface fixes a boundary, all siblings get
 * audited in the same pass — the drop-handlers drift gate
 * (`scripts/check-drop-handlers.ts`) routing-arm watches both files
 * and fails CI if either captures DataTransfer events without
 * routing through `runtime.feedPerception`.
 *
 * Doctrine: `motebit-computer.md` §"Supervised agency / minimum
 * gesture set" names the drop gesture; the protocol-layer substrate
 * (`DropPayload` in `@motebit/protocol`) types the payload; the
 * runtime API (`MotebitRuntime.feedPerception`) is the single entry
 * point.
 *
 * v1 default target is `slab`. The other two targets (`creature`,
 * `ambient`) require spatial separation to disambiguate, OR a
 * 2D-scene raycast pick at drop time. The runtime fails closed on
 * non-slab targets via `DropTargetGovernanceRequiredError` until the
 * per-target governance UX (creature confirmation modal, ambient
 * consultable-context store) ships.
 *
 * Per doctrine §"Failure modes specific to supervised agency":
 *
 *   - **Prompt-backdoor gestures**. A drag-to-feed that secretly
 *     appends text to the next user message. Perception is not a
 *     message; keep the channels typed and separate. → We
 *     `preventDefault` on every drop the runtime has accepted, so
 *     the dropped content never falls through to the chat input's
 *     default text insertion.
 *
 * Future: when a third surface (mobile, spatial) lands a DOM-or-
 * webview-equivalent drop path, `classifyDragEventToDropPayload`
 * extracts to a shared location. For two surfaces the reviewer
 * (correctly) preferred mirrored implementations + drift-gate
 * coverage over a premature shared abstraction.
 */

import type { MotebitRuntime } from "@motebit/runtime";
import type { DropPayload, UserActionAttestation } from "@motebit/sdk";

interface DropHandlersOptions {
  /** Returns the active runtime, or null when not yet wired. */
  getRuntime: () => MotebitRuntime | null;
}

/**
 * Attach document-level drag-drop listeners that route every drop
 * the surface accepts through `runtime.feedPerception`. Returns a
 * teardown function; the caller keeps the surface alive so teardown
 * is mostly used in tests.
 */
export function initDropHandlers(opts: DropHandlersOptions): () => void {
  const onDragOver = (e: DragEvent): void => {
    if (e.dataTransfer === null) return;
    // The browser cancels drop unless dragover preventDefault fires;
    // doing so unconditionally here means the page accepts drops
    // anywhere, then `onDrop` decides whether to consume them.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (e: DragEvent): void => {
    if (e.dataTransfer === null) return;
    const payload = classifyDropEvent(e);
    if (payload === null) return; // unknown shape — let the browser default fire
    e.preventDefault();
    const runtime = opts.getRuntime();
    if (runtime === null) {
      // Runtime not yet wired (first-run, signed-out). Silently drop
      // for v1; future: surface a toast.
      return;
    }
    void runtime.feedPerception(payload);
  };

  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
  return () => {
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("drop", onDrop);
  };
}

/**
 * Classify a DOM `DragEvent` into a typed `DropPayload`. Inspection
 * order matches user-intent frequency: URL > text > image. File
 * drops are deferred for v1.1 — `DataTransfer.files` is read but
 * classified only when an image MIME is detected; binary file drops
 * (PDFs, archives, etc.) no-op pending the file-handler extension
 * surface.
 *
 * Returns `null` when the drop carries nothing the runtime knows how
 * to handle, so the caller leaves the browser default in place
 * rather than silently swallowing the gesture.
 *
 * Mirrors the web surface's implementation byte-for-byte except for
 * the attestation's `surface` field — the DataTransfer shape is
 * identical between Chromium-on-the-web and Tauri's Chromium-in-a-
 * webview. The drift gate enforces the routing arm; the byte-shape
 * mirroring is enforced by reviewer eye + this comment.
 */
function classifyDropEvent(e: DragEvent): DropPayload | null {
  const dt = e.dataTransfer;
  if (dt === null) return null;
  const attestation: UserActionAttestation = {
    kind: "user-drag",
    timestamp: Date.now(),
    surface: "desktop",
  };

  // 1. URL — highest-frequency desktop/web intent. text/uri-list is
  //    the canonical MIME; some browsers fall back to text/plain
  //    containing a URL string.
  const uriList = dt.getData("text/uri-list");
  if (uriList !== "" && uriList !== undefined) {
    const url = uriList.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#"));
    if (url !== undefined) {
      return {
        kind: "url",
        url: url.trim(),
        sourceFrame: tryGetData(dt, "text/html") || undefined,
        attestation,
      };
    }
  }

  // 2. Image — dragged image content (browser-native or file system).
  //    `dataTransfer.files` carries `File` objects with a `type`. A
  //    drag from another browser tab may also expose the bytes inline
  //    via `getData("application/octet-stream")`; for v1 we only
  //    accept the file path (less brittle, browser-consistent).
  const files = Array.from(dt.files ?? []);
  const imageFile = files.find((f) => f.type.startsWith("image/"));
  if (imageFile !== undefined) {
    // v1: metadata-only payload (byteLength reads as 0). The richer
    // path (Promise<DropPayload> with bytes loaded) lands in v1.1
    // alongside vision-provider integration.
    return {
      kind: "image",
      bytes: new Uint8Array(0),
      mimeType: imageFile.type,
      attestation,
    };
  }

  // 3. Text — plain or markdown selection. Only fires when nothing
  //    URL- or image-shaped matched.
  const text = dt.getData("text/plain");
  if (text !== "" && text !== undefined) {
    const mimeType = tryGetData(dt, "text/markdown") !== "" ? "text/markdown" : "text/plain";
    return { kind: "text", text, mimeType, attestation };
  }

  // Unknown shape — the runtime has no handler today. Returning null
  // lets the browser default fire.
  return null;
}

/**
 * `DataTransfer.getData(format)` throws when the format isn't
 * available in some browsers. Wrap in try/catch and return empty
 * string on failure so the caller branches cleanly.
 */
function tryGetData(dt: DataTransfer, format: string): string {
  try {
    return dt.getData(format);
  } catch {
    return "";
  }
}
