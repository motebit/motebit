---
"@motebit/web": minor
---

Defer model setup to the first message — stop occluding the creature with a "Connect a model" overlay on load.

First run used to demand setup before the user had done anything: a centered "Connect a model" prompt painted across the creature's face (low-contrast, occluding the hero), and on capable devices a multi-GB WebLLM download kicked off automatically. Both are un-calm — setup before intent.

Now the first run is just the creature + the calm "born" welcome. Nothing inference-y happens on load (no localhost probe — already removed — no auto-download, no overlay). A subscriber's saved cloud provider still auto-connects. When a user without a model **sends their first message**, motebit answers inline — "I need a model to think. Choose one in Settings — on-device, your own key, or motebit cloud." — and opens Settings straight to the Intelligence (provider) tab. Setup follows intent, never precedes it.

- `updateConnectPrompt` retires the empty-state overlay (only ever hides now); the connect-prompt node serves solely as the boot-time WebLLM progress surface for a returning on-device user, which un-hides itself.
- Removed the on-load WebLLM auto-download from both boot paths; the saved-on-device-WebLLM path is unchanged.
- New `openProviderSettings` chat callback → `settings.openToTab("intelligence")`.
