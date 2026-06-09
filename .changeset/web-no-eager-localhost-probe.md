---
"@motebit/web": patch
---

Stop probing localhost on first load — kill the scary "access other apps and services on this device" permission.

On first visit the web app eagerly raced probes against `http://localhost:11434/1234/8080/…` looking for a local Ollama/LM-Studio server (`autoInitLocalInference`). From the HTTPS origin that trips Chrome's Private Network Access prompt — "motebit.com wants to access other apps and services on this device" — a context-free, malware-flavored system permission shown to every new visitor, for a feature almost no one uses uninvited. Deeply un-calm and un-Jobsian.

The eager probe is removed from both boot paths (fresh visit and cloud-config refresh). First-run boot is now: subscriber proxy → in-browser WebLLM (zero-config, no permission) → connect prompt — no localhost contact, no permission prompt. Local-server inference is unchanged and fully available, but **opt-in via Settings → On-Device → server** (`settings.ts` already owns detection there), where the user explicitly asks for it and the permission is in-context. Returning users with a saved local-server config still connect to their chosen endpoint as before.
