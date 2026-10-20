---
"motebit": patch
---

Installing the CLI no longer needs a native compiler. `better-sqlite3` is now an optional dependency: when its prebuilt binary can't be fetched and no C/C++ toolchain is present, npm skips it instead of failing the whole `npm install -g motebit`. The CLI then opens its database on the sql.js fallback and prints one notice on stderr naming the durability difference (in-memory, rewritten to disk up to ~1s after each change, no WAL). The native driver stays the default whenever it installs. `motebit doctor` labels the fallback.
