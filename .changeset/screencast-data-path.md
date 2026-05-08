---
"@motebit/protocol": minor
"@motebit/browser-sandbox": minor
---

v1.3 of the virtual_browser arc — `ScreencastFrame` wire-format type
for live JPEG streaming from the cloud-browser service.

Per-action screenshots produced "moments" — the slab read as a
slideshow of stills, not a window into a browser. v1.3 swaps that for
a continuous JPEG frame stream from CDP `Page.startScreencast`.
`ScreencastFrame` is the wire shape both the server (`services/
browser-sandbox`) and the dispatcher (`@motebit/runtime`'s
`CloudBrowserDispatcher`) consume:

```ts
interface ScreencastFrame {
  readonly jpeg_base64: string;
  readonly timestamp: number; // wall-clock ms, normalized from CDP seconds
  readonly device_width: number;
  readonly device_height: number;
}
```

Lives at the protocol layer next to the `ComputerSession*` cluster —
both producer and consumer reference one canonical shape, no drift
between server JSON and client decode.

Slice 1 of v1.3 (data path). The cloud-browser service ships the
`GET /sessions/:id/screencast` NDJSON-streaming endpoint; the
dispatcher ships `openScreencast({onFrame, onError})`; the slab UI
swap follows in slice 2.
