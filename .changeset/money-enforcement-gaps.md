---
"motebit": patch
---

`motebit serve --direct` no longer executes a served tool straight from the registry. Both of its task doors — the MCP `motebit_task` tool and the relay WebSocket dispatch — now execute through the runtime's policy gate (`MotebitRuntime.executeToolGated`): the same decision a direct MCP call of the tool gets, and an R4_MONEY tool runs only under a verified, in-scope standing grant. Without one it is refused with a failed receipt, never queued, because no human is on this path. `serve --direct --grant <id>` presents a stored grant (from `motebit grant create`) to each task. Behaviour change: a tool above the governance auto-allow band (for example R2+ under the default ambient preset) is now refused on this path, as it already was when called over MCP.
