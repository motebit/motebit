---
"motebit": patch
---

Consent describes what actually happens: the money-approval band now states that the payment route is late-bound (if peer payment is unavailable, the task reroutes through the relay with no wallet payment), the route switch renders and is stated in the delegation result when it occurs, and the relay-mode settlement note no longer overclaims a payment. Also: attached surfaces render approval expiry/void outcomes, and the goals daemon contains drain errors instead of leaking unhandled rejections.
