import { ImageResponse } from "next/og";

// Social share card for docs.motebit.com — auto-wired by Next as og:image and
// twitter:image. Code-generated (no design asset to maintain); the dark droplet
// + wordmark + hero line on the warm Liquescentia gradient. Swap this file for a
// static designed PNG later if desired. Preview locally at /opengraph-image.
export const alt = "Motebit — Sovereign Agent Infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "88px",
        background: "linear-gradient(135deg, #c7bfe0 0%, #e9ddca 55%, #d8b48f 100%)",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: "36px" }}>
        <div
          style={{
            width: "52px",
            height: "52px",
            borderRadius: "9999px",
            background: "#1c1917",
            marginRight: "20px",
          }}
        />
        <div
          style={{ fontSize: "40px", fontWeight: 600, color: "#1c1917", letterSpacing: "-0.02em" }}
        >
          Motebit
        </div>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: "70px",
          fontWeight: 700,
          color: "#1c1917",
          letterSpacing: "-0.03em",
          lineHeight: 1.05,
          maxWidth: "920px",
        }}
      >
        A droplet of intelligence under surface tension.
      </div>
      <div style={{ display: "flex", fontSize: "30px", color: "#44403c", marginTop: "30px" }}>
        Identity at the boundary. Intelligence in the interior. Governance at the surface.
      </div>
    </div>,
    { ...size },
  );
}
