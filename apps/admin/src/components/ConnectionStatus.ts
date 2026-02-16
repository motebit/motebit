import React from "react";

export function ConnectionStatus({ connected }: { connected: boolean }): React.ReactElement {
  return React.createElement("div", { className: "connection-status" },
    React.createElement("div", {
      className: `status-dot ${connected ? "connected" : "disconnected"}`,
    }),
    React.createElement("span", null, connected ? "Connected" : "Disconnected"),
  );
}
