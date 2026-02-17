import { docs } from "@/.source";
import { loader } from "fumadocs-core/source";

const raw = docs.toFumadocsSource();

// fumadocs-mdx returns files as a function; fumadocs-core expects an array.
// Cast through unknown to call the function while preserving the generic type.
const files =
  typeof raw.files === "function"
    ? (raw.files as unknown as () => typeof raw.files)()
    : raw.files;

export const source = loader({
  baseUrl: "/docs",
  source: { files },
});
