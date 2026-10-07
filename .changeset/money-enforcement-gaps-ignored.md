---
"@motebit/runtime": patch
"@motebit/relay": patch
---

Close two money-path enforcement gaps found by a composition audit.

**M1 — settlement-authority binding via federation discovery.** The relay's discover merge no longer lets a federation peer speak for an agent registered on this relay (any registry row, on or off the shelf), drops a direct (`hop_distance: 1`) peer answer whose `source_relay` is not the peer that returned it, strips the pay-to address (and any peer-supplied `source_relay_public_key`) from entries whose host is not an active direct peer, and the same local-shadow rule now applies to task routing's federated candidates. The `p2p-eligibility` pre-flight returns the worker's own registered `settlement_address`. `resolveP2pPaymentRequest` treats a candidate as LOCAL only on the origin's `hop_distance: 0` mark (never "no peer key"), refuses peer-listed candidates it cannot bind (`worker_settlement_unbound`), and refuses a local candidate whose discovered address differs from the one the relay's registry confirms.

**M2 — R4_MONEY on the worker task path.** `motebit serve --direct` (both the MCP `motebit_task` tool and the relay WebSocket dispatch) now executes through the new `MotebitRuntime.executeToolGated` — the policy gate plus `verifyGrantForTurn`, refusing on `requiresApproval` and binding a verified grant to the rail meter — instead of the raw registry. `serve --direct --grant <id>` presents a stored standing grant per task. `check-money-authority` gains assertion 5: every tool-registry `execute(` is a closed set of sanctioned gated sites.
