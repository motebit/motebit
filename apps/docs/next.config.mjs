import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Next.js forces jsx: "preserve" in tsconfig.json, which triggers React types
  // conflicts in pnpm monorepos. Type safety is enforced via the standalone
  // typecheck script (tsconfig.typecheck.json with jsx: "react-jsx") instead.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ["@motebit/render-engine", "@motebit/sdk", "@motebit/policy-invariants"],
  // docs.motebit.com is documentation only — the product and its story live
  // at motebit.com. The root is the Introduction, permanently (308).
  async redirects() {
    return [
      { source: "/", destination: "/docs/introduction", permanent: true },
      { source: "/docs", destination: "/docs/introduction", permanent: true },
      { source: "/compare", destination: "/docs/concepts/interior-color", permanent: true },
    ];
  },
};

export default withMDX(config);
