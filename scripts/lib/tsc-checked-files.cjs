/**
 * Ask TypeScript — the very compiler a `typecheck` script ran — whether it
 * TYPE-CHECKS each of a set of files. Used by scripts/check-tests-typechecked.ts.
 *
 * Run as `node tsc-checked-files.cjs` in the invocation's cwd with a JSON
 * request on stdin: `{ tsLib, argv, files }` — the `typescript.js` next to the
 * recorded `tsc`, the recorded argv (allowlisted: -p/--project, -b/--build,
 * --noEmit, --pretty) and the absolute paths to ask about. It builds that
 * invocation's own Program (config parse + createProgram, no type-check) and
 * prints `{ roots, results: { [file]: { root, inProgram, skip } } }`: `root` =
 * the file is one of the program's root files; `inProgram` = it is in the
 * program at all (a root, or reached by an import); `skip` = null when tsc
 * type-checks it,
 * else the reason it does not, read from the compiler itself:
 *
 * - a declaration file (`SourceFile.isDeclarationFile`, i.e.
 *   `ts.isDeclarationFileName`: `.d.ts` AND any `.d.<ext>.ts`, so
 *   `api.d.test.ts` is one) — never checked as code, skipped outright under
 *   skipLibCheck. Always a skip here, whatever skipLibCheck says.
 * - otherwise whatever `ts.skipTypeChecking(sourceFile, options, program)` —
 *   the checker's own skip test — says: noCheck, skipDefaultLibCheck on a
 *   no-default-lib file, a project-reference redirect source, or a
 *   `@ts-nocheck` (`checkJsDirective`) / unchecked JS file.
 *
 * `selfTest` fails closed (throws) when that TypeScript no longer behaves the
 * way this reading assumes — e.g. an upgrade renamed `checkJsDirective`.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Why tsc does not type-check `sf` under `options`, or null when it does. */
function skipReason(ts, sf, options, host) {
  if (sf.isDeclarationFile) {
    return `is a declaration file to TypeScript ${ts.version} (its name ends \`.d.ts\` or \`.d.<ext>.ts\` — ts.isDeclarationFileName), so tsc never checks it as code${options.skipLibCheck ? " and skipLibCheck skips it entirely" : ""} — rename it (a test must not be named \`*.d.*.ts\`); ambient declarations do not belong in the test tree (a \`declare module\` there can loosen what the tests import)`;
  }
  if (!ts.skipTypeChecking(sf, options, host)) return null;
  if (options.noCheck) return "is skipped by the `noCheck` compiler option";
  if (options.skipDefaultLibCheck && sf.hasNoDefaultLib) {
    return 'carries `/// <reference no-default-lib="true"/>`, which skipDefaultLibCheck skips — remove the directive';
  }
  if (host.isSourceOfProjectReferenceRedirect(sf.fileName)) {
    return "is the source of a project-reference redirect — this tsc does not check it; compile it in its own project's typecheck";
  }
  const d = sf.checkJsDirective;
  if (d && !d.enabled) {
    return "carries `@ts-nocheck` (tsc reads it in the leading comments, any case) — remove it and fix the errors it hides";
  }
  return "is skipped by tsc (ts.skipTypeChecking — e.g. a JavaScript file without checkJs) — write it in TypeScript";
}

/** Fail closed if this TypeScript no longer behaves as `skipReason` reads it. */
function selfTest(ts, where = "") {
  const host = { isSourceOfProjectReferenceRedirect: () => false };
  const sf = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false);
  const skipped = (name, text, o = {}) => ts.skipTypeChecking(sf(name, text), o, host);
  const checks = [
    ["`// @TS-NOCHECK` skips", skipped("p.test.ts", "// @TS-NOCHECK\nexport {};\n") === true],
    [
      "`\\uFEFF//@Ts-NoCheck: x` skips",
      skipped("p.test.ts", "﻿//@Ts-NoCheck: x\nexport {};\n") === true,
    ],
    [
      "a later `@ts-check` wins",
      skipped("p.test.ts", "// @ts-nocheck\n// @ts-check\nexport {};\n") === false,
    ],
    [
      "a pragma after code is ignored",
      skipped("p.test.ts", "export {};\n// @ts-nocheck\n") === false,
    ],
    ["a plain test is checked", skipped("p.test.ts", "export {};\n") === false],
    ["noCheck skips", skipped("p.test.ts", "export {};\n", { noCheck: true }) === true],
    [
      "`.d.test.ts` is a declaration file",
      ts.isDeclarationFileName("a.d.test.ts") === true &&
        sf("a.d.test.ts", "export {};\n").isDeclarationFile === true,
    ],
    [
      "skipLibCheck skips a declaration file",
      skipped("a.d.test.ts", "export {};\n", { skipLibCheck: true }) === true,
    ],
    ["`.test.ts` is not a declaration file", ts.isDeclarationFileName("a.test.ts") === false],
  ];
  const broken = checks.filter(([, ok]) => !ok).map(([what]) => what);
  if (broken.length > 0) {
    throw new Error(
      `TypeScript ${ts.version}${where ? ` at ${where}` : ""}: the gate's reading of the compiler's skip rules no longer matches what tsc does (${broken.join("; ")}) — update scripts/lib/tsc-checked-files.cjs`,
    );
  }
}

/** The recorded argv as a plain `tsc -p` argv (`-b x` → `-p x`, no --pretty). */
function projectArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-b" || t === "--build") out.push("-p", argv[++i]);
    else if (t !== "--pretty") out.push(t);
  }
  return out;
}

function check(ts, argv, files) {
  const cmd = ts.parseCommandLine(projectArgv(argv));
  const errors = cmd.errors.filter((e) => e.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(
      `tsc argv ${JSON.stringify(argv)}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; ")}`,
    );
  }
  let project = path.resolve(cmd.options.project ?? "tsconfig.json");
  if (fs.existsSync(project) && fs.statSync(project).isDirectory()) {
    project = path.join(project, "tsconfig.json");
  }
  const { project: _p, ...cliOptions } = cmd.options;
  const parsed = ts.getParsedCommandLineOfConfigFile(project, cliOptions, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`${project}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    },
  });
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  if (typeof program.isSourceOfProjectReferenceRedirect !== "function") {
    throw new Error(
      `TypeScript ${ts.version}: Program.isSourceOfProjectReferenceRedirect is gone — update scripts/lib/tsc-checked-files.cjs`,
    );
  }
  const roots = new Set(program.getRootFileNames().map((f) => path.resolve(f)));
  const options = program.getCompilerOptions();
  const results = {};
  for (const f of files) {
    const sf = program.getSourceFile(f);
    results[f] = {
      root: roots.has(path.resolve(f)),
      inProgram: Boolean(sf),
      skip: sf ? skipReason(ts, sf, options, program) : "is not in the program tsc builds",
    };
  }
  return { roots: roots.size, results };
}

module.exports = { selfTest, skipReason, projectArgv };

if (require.main === module) {
  const req = JSON.parse(fs.readFileSync(0, "utf-8"));
  const ts = require(req.tsLib);
  selfTest(ts, req.tsLib);
  process.stdout.write(JSON.stringify(check(ts, req.argv, req.files)));
}
