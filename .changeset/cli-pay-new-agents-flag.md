---
"motebit": patch
---

Add `--pay-new-agents`, the CLI's paid-P2P cold-start opt-in — surface parity with the web/desktop/mobile "Pay new agents directly" toggle.

The cold-start acknowledgment (`acknowledgeNoHistoryRisk`) was wired only on web. On the CLI, `enableInteractiveDelegation` / `enableInvokeCapability` omitted it, so the runtime's auto-bound sovereign P2P path was a no-op for a first paid delegation to a worker with no trust history — it silently degraded to relay-mode with no operator control. The new flag forwards the ack into both delegation entry points (`apps/cli/src/index.ts` chat + invoke paths, `apps/cli/src/subcommands/delegate.ts`).

Process-lifetime config, so a plain boolean — no live getter (unlike the web/desktop localStorage and mobile in-memory-mirror getters that let an interactive toggle take effect without a re-enable). Default OFF (sovereign fail-closed): without `--pay-new-agents`, a paid delegation to an unknown worker still settles through the relay ledger. Use `motebit run --pay-new-agents` (or `delegate`) to allow direct peer-to-peer payment of new agents from the sovereign wallet.
