import { BUNDLED } from "@fx/bundler";
import { writeFileSync } from "node:fs";
writeFileSync("src/bundle.generated.txt", BUNDLED);
