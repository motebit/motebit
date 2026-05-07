/**
 * Drop handlers — DOM drag-drop → typed `feedPerception` payload.
 *
 * Doctrine: `motebit-computer.md` §"Supervised agency / minimum
 * gesture set" names the drop gesture; the protocol-layer substrate
 * (`DropPayload` in `@motebit/protocol`) types the payload; the
 * runtime API (`MotebitRuntime.feedPerception`) is the single entry
 * point. This module is the per-surface translator: it captures DOM
 * `dragover` / `drop` events, extracts `DataTransfer` data, classifies
 * into the closed `DropPayloadKind` union, and calls `feedPerception`.
 *
 * v1 default target is `slab`. The other two targets (`creature`,
 * `ambient`) require spatial separation to disambiguate; on a 2D web
 * surface there's no unambiguous gesture for them, so they wait until
 * spatial Phase 1B.
 *
 * Per doctrine §"Failure modes specific to supervised agency":
 *
 *   - **Prompt-backdoor gestures**. A drag-to-feed that secretly
 *     appends text to the next user message. Perception is not a
 *     message; keep the channels typed and separate. → We
 *     `preventDefault` on every drop the runtime has accepted, so the
 *     dropped content never falls through to the chat input's
 *     default text insertion.
 *
 * Per drift gate `check-drop-handlers`: surface drop handlers MUST
 * route through `runtime.feedPerception`; never construct a prompt
 * string and call `sendMessage` / `sendMessageStreaming`.
 */

import type { MotebitRuntime } from "@motebit/runtime";
import type { DropPayload, UserActionAttestation } from "@motebit/sdk";

interface DropHandlersOptions {
  /** Returns the active runtime, or null when not yet wired. */
  getRuntime: () => MotebitRuntime | null;
}

/**
 * Attach document-level drag-drop listeners that route every drop the
 * surface accepts through `runtime.feedPerception`. Returns a teardown
 * function; the caller (main.ts) keeps the surface alive so teardown
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
 * order matches user-intent frequency: URL > text > image. File drops
 * are deferred for v1.1 — `DataTransfer.files` is read but classified
 * as a `text` payload only when the file's MIME is text-shaped; binary
 * files no-op.
 *
 * Returns `null` when the drop carries nothing the runtime knows how
 * to handle, so the caller leaves the browser default in place rather
 * than silently swallowing the gesture.
 */
function classifyDropEvent(e: DragEvent): DropPayload | null {
  const dt = e.dataTransfer;
  if (dt === null) return null;
  const attestation: UserActionAttestation = {
    kind: "user-drag",
    timestamp: Date.now(),
    surface: "web",
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
    // Note: we kick the bytes-read off async but return the payload
    // synchronously; the runtime's image handler reads `bytes` so we
    // need them present. Inline async here (return a Promise<DropPayload>
    // would change the signature) — instead we wrap as a Promise and
    // unwrap above. For v1 simplicity, we stage a synchronous payload
    // with empty bytes and let the handler observe `byteLength === 0`.
    // The richer path (Promise<DropPayload>) lands in v1.1 alongside
    // the vision-provider integration.
    return {
      kind: "image",
      bytes: new Uint8Array(0), // v1: metadata-only; bytes come in v1.1
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
  // lets the browser default fire (e.g., dropping a custom MIME from
  // another web app does whatever that app's drag source intended).
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
