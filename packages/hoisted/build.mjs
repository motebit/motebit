import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("src/index.js", "dist/index.js");
