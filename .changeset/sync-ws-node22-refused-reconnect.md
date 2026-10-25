---
"motebit": patch
---

On Node 22, the CLI's relay sync now reconnects when the relay was unreachable at connect time. Before, a daemon started while the relay was down could stay disconnected until something forced a new connection.
