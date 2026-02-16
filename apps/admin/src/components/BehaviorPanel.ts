import React from "react";
import type { BehaviorCues } from "@motebit/sdk";

const h = React.createElement;

interface BehaviorPanelProps {
  cues: BehaviorCues;
}

export function BehaviorPanel({ cues }: BehaviorPanelProps): React.ReactElement {
  // Mote preview: position and glow from cues
  const glowSize = Math.round(cues.glow_intensity * 40);
  const verticalOffset = Math.round(cues.hover_distance * -60 + 30); // higher hover_distance = further away, so move up

  const moteStyle: React.CSSProperties = {
    width: 60,
    height: 60,
    borderRadius: "50% 50% 50% 45%",
    background: "rgb(235, 242, 250)",
    boxShadow: `0 0 ${glowSize}px ${Math.round(glowSize * 0.6)}px rgba(235, 242, 250, ${cues.glow_intensity * 0.7})`,
    transform: `translateY(${verticalOffset}px)`,
    transition: "all 0.5s ease",
  };

  const preview = h("div", { className: "mote-preview-container" },
    h("div", { className: "mote-body", style: moteStyle }),
  );

  const fields = [
    { name: "hover_distance", value: cues.hover_distance },
    { name: "drift_amplitude", value: cues.drift_amplitude },
    { name: "glow_intensity", value: cues.glow_intensity },
    { name: "eye_dilation", value: cues.eye_dilation },
    { name: "smile_curvature", value: cues.smile_curvature },
  ];

  const readout = fields.map((f) =>
    h("div", { key: f.name, className: "field" },
      h("span", { className: "label" }, f.name),
      h("span", { className: "value" }, f.value.toFixed(4)),
      h("div", { className: "bar", style: { width: `${Math.abs(f.value) * 100}%` } }),
    ),
  );

  return h("div", { className: "panel" },
    h("h2", null, "Behavior Cues"),
    preview,
    ...readout,
  );
}
