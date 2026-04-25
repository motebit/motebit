import type { MDXComponents } from "mdx/types";
import defaultComponents from "fumadocs-ui/mdx";
import { DiagramFigure } from "./components/diagram-figure";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...(defaultComponents as MDXComponents),
    DiagramFigure,
    ...components,
  };
}
