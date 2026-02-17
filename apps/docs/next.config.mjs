import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Skip build-time type check — React 18/19 types conflict in monorepo.
  // Type safety is enforced via `pnpm --filter @motebit/docs typecheck` instead.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default withMDX(config);
