---
"motebit": patch
---

Typed `quit`/`exit` now exits the process explicitly, mirroring the Ctrl+C path. Previously "Goodbye!" printed but the process survived on any live handle (the sovereign rail's RPC connection, an MCP socket), leaving a zombie REPL holding the terminal.
