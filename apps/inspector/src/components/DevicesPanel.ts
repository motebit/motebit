import React from "react";
import type { DeviceEntry } from "../api";

function fingerprint(publicKey: string): string {
  // Show first 16 hex chars as a fingerprint preview
  const clean = publicKey.replace(/^0x/, "");
  if (clean.length <= 16) return clean;
  return clean.slice(0, 16) + "...";
}

// Inline did:key derivation (pure math, no crypto deps needed)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function hexToDidKey(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64) return "";
  const bytes = new Uint8Array(34);
  bytes[0] = 0xed;
  bytes[1] = 0x01;
  for (let i = 0; i < 32; i++) bytes[i + 2] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = v * 256n + BigInt(bytes[i]!);
  let r = "";
  while (v > 0n) {
    r = B58[Number(v % 58n)]! + r;
    v /= 58n;
  }
  return `did:key:z${B58[0]!.repeat(zeros)}${r}`;
}

export function DevicesPanel({ devices }: { devices: DeviceEntry[] }): React.ReactElement {
  const sorted = [...devices].sort((a, b) => b.registered_at - a.registered_at);

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Devices"),
    React.createElement("div", { className: "count" }, `${devices.length} devices registered`),
    ...sorted.map((d) =>
      React.createElement(
        "div",
        { key: d.device_id, className: "event-entry device-entry" },
        React.createElement(
          "div",
          { className: "device-header" },
          React.createElement(
            "span",
            { className: "device-name" },
            d.device_name != null && d.device_name !== ""
              ? d.device_name
              : d.device_id.slice(0, 12),
          ),
          React.createElement("span", { className: "device-id" }, d.device_id.slice(0, 12) + "..."),
        ),
        React.createElement(
          "div",
          { className: "device-meta" },
          React.createElement(
            "span",
            { className: "device-key" },
            `key: ${fingerprint(d.public_key)}`,
          ),
          hexToDidKey(d.public_key)
            ? React.createElement(
                "span",
                { className: "device-key", style: { fontSize: "10px" } },
                hexToDidKey(d.public_key),
              )
            : null,
          React.createElement(
            "span",
            { className: "timestamp" },
            `registered ${new Date(d.registered_at).toISOString()}`,
          ),
          d.last_seen_at != null
            ? React.createElement(
                "span",
                { className: "timestamp" },
                `last seen ${new Date(d.last_seen_at).toISOString()}`,
              )
            : React.createElement("span", { className: "timestamp" }, "never seen"),
        ),
      ),
    ),
  );
}
