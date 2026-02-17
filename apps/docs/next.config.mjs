import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Next.js forces jsx: "preserve" in tsconfig.json, which triggers React types
  // conflicts in pnpm monorepos. Type safety is enforced via the standalone
  // typecheck script (tsconfig.typecheck.json with jsx: "react-jsx") instead.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default withMDX(config);
