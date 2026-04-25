import type { MDXComponents } from "mdx/types";
import defaultComponents from "fumadocs-ui/mdx";
import { DiagramFigure } from "./components/diagram-figure";
import { ReferenceExample } from "./components/reference-example";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...(defaultComponents as MDXComponents),
    DiagramFigure,
    ReferenceExample,
    ...components,
  };
}
