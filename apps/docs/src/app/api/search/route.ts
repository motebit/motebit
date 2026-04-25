import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

/**
 * Fumadocs full-text search API.
 *
 * The `createFromSource` helper builds an in-process Flexsearch
 * index from every page the source loader knows about (every
 * `.mdx` under `apps/docs/content/docs/`). Index lives in memory
 * on the server; queries are sub-millisecond. RootProvider in
 * `apps/docs/src/app/layout.tsx` already wires up the cmd+K
 * dialog — this endpoint is the backend it calls.
 */
export const { GET } = createFromSource(source);
