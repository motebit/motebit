import React, { useState } from "react";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { WithdrawalsPanel } from "./components/WithdrawalsPanel";
import { FederationPeersPanel } from "./components/FederationPeersPanel";
import { TransparencyPanel } from "./components/TransparencyPanel";
import { DisputesPanel } from "./components/DisputesPanel";
import { FeesPanel } from "./components/FeesPanel";
import { CredentialAnchoringPanel } from "./components/CredentialAnchoringPanel";
import { config } from "./api";

const TABS = [
  "withdrawals",
  "federation",
  "transparency",
  "disputes",
  "fees",
  "anchoring",
] as const;

type Tab = (typeof TABS)[number];

export function OperatorApp(): React.ReactElement {
  const [activePanel, setActivePanel] = useState<Tab>("withdrawals");

  // Connection presence is implicit — every panel does its own fetch and
  // surfaces failures as state. Top-level dot reflects "is the relay URL
  // configured" (not a probe). For a hot-probe surface, use the inspector.
  const connected = config.apiUrl.length > 0 && config.apiToken.length > 0;

  const nav = React.createElement(
    "nav",
    { className: "operator-nav" },
    TABS.map((panel) =>
      React.createElement(
        "button",
        {
          key: panel,
          className: panel === activePanel ? "active" : "",
          onClick: () => setActivePanel(panel),
        },
        panel,
      ),
    ),
  );

  let content: React.ReactElement;
  switch (activePanel) {
    case "withdrawals":
      content = React.createElement(WithdrawalsPanel, null);
      break;
    case "federation":
      content = React.createElement(FederationPeersPanel, null);
      break;
    case "transparency":
      content = React.createElement(TransparencyPanel, null);
      break;
    case "disputes":
      content = React.createElement(DisputesPanel, null);
      break;
    case "fees":
      content = React.createElement(FeesPanel, null);
      break;
    case "anchoring":
      content = React.createElement(CredentialAnchoringPanel, null);
      break;
    default:
      content = React.createElement(
        "div",
        { className: "panel" },
        React.createElement("p", null, "Unknown panel"),
      );
  }

  const header = React.createElement(
    "div",
    { className: "operator-header" },
    React.createElement("h1", null, "Motebit Operator"),
    React.createElement(ConnectionStatus, { connected }),
  );

  return React.createElement("div", { className: "operator-app" }, header, nav, content);
}
