// No-op stub for ajv-formats. Prevents the ajv@6 / ajv-formats@3
// module conflict from crashing tests. The MCP SDK calls
// addFormats(ajv) during initialization — this simply does nothing.
"use strict";

function addFormats() {
  // no-op — format validation is not needed for tests
}

addFormats.default = addFormats;
module.exports = addFormats;
