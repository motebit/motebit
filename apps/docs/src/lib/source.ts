import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";

// fumadocs-mdx's `@/.source/server` carries `@ts-nocheck`, so the
// `docs.toFumadocsSource()` call resolves as `error`-typed under
// `@typescript-eslint/no-unsafe-*` on CI (local lint caches a
// resolved type and silently passes). The disable applies to the
// `loader(...)` call itself — the only site where the unsafe-typed
// expression flows.
export const source = loader(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- generated source uses @ts-nocheck
  docs.toFumadocsSource(),
  {
    baseUrl: "/docs",
  },
);
