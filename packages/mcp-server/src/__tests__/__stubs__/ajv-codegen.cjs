// No-op stub for ajv/dist/compile/codegen.
// Prevents import failures when ajv-formats@3 tries to load ajv@8 codegen.
"use strict";

module.exports = {
  _: (s) => s,
  str: (s) => s,
  stringify: JSON.stringify,
  nil: "",
  Name: class Name { constructor(s) { this.str = s; } },
  Code: class Code { constructor(s) { this.str = s; } },
  KeywordCxt: class KeywordCxt {},
};
