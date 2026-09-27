import { VALUE } from "@fx/proto";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export const BUNDLED = " + JSON.stringify(VALUE) + ";\n");
