---
"motebit": patch
---

`/model` is no longer provider-blind (#471): the list names each model's provider and dims rows the active provider can't serve; switching to an unservable model refuses with the repair (`claude-opus-5 is a hosted anthropic model — restart with --provider anthropic, or pick a local model`) instead of renaming the model, moving the marker, and persisting a broken default. An admitted switch now persists the provider+model PAIR, so a later bare `motebit` launch restores the provider the model was chosen on. Launch-side admission gains the same CLI strictness — a persisted hosted-vendor id no longer rides onto local-server to 404 at the first message.
