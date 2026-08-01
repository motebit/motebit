---
"motebit": minor
---

Capability-tiered tool admission (#501): a minimal-tier model (e.g. a 3B local model) is no longer offered money-moving tools by default — the runtime omits `R4_MONEY`-classified tools from the model-visible list and fail-closes execution, so the witnessed incident class (a weak model fabricating a real-money hire proposal from noise) becomes unrepresentable instead of merely caught by the approval gate. A rail-less `delegate_to_agent` (no wallet bound) stays available — the tool crosses the withholding line exactly when it can move money. Mid-session `/model` switches adjust exposure live. Sovereignty preserved: set `offer_money_tools_to_minimal_models: true` in `~/.motebit/config.json` to restore full exposure; the CLI says what's withheld in one dim line at launch and on `/model` switch, never mid-conversation. User-tap `/invoke` is unaffected (a tap is its own authorizer).
