---
"@motebit/desktop": patch
"@motebit/mobile": patch
---

Interior reasoning render (Inc 3) — fan the `reasoning` disclosure out to desktop and mobile. Desktop mirrors web's calm collapsed `<details>` in the assistant bubble (DOM, inline CSS). Mobile renders a native `ReasoningDisclosure` (a `TouchableOpacity` ▸/▾ toggle over muted body text) under the reply, with a `reasoning?` field carried on the chat message and accumulated across the turn's reasoning rounds. Both are the `mind` register's flat-surface form: collapsed by default (calm), opt-in expand (felt-interior), muted + secondary to the reply, and INTERIOR-ONLY (held in ephemeral DOM / local UI state, never persisted or synced). Spatial expresses reasoning-happening through the existing presence/creature cue (content-in-AR is a separate arc, not forced text); cli deferred (a terminal stream has no collapse affordance).
