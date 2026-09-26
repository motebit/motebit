---
"@motebit/relay": patch
---

An ended credential stops holding the sync sockets it admitted, at every door that ends one (#776). Rotation already closed the sockets its retired key admitted (#767). The other doors that end a key or an identity left those sockets open until they dropped on their own.

- **Identity revocation** closes every socket that an identity credential admitted, under any key: the identity's own key, a device linked without key transfer, or the registry fallback. The close code is new: `4011` ("Identity revoked"). This covers `/revoke`, migration departure, and the operator's `revoke-listing` hold, which also makes the verifier refuse the identity's tokens.
- **Token revocation** (`/revoke-tokens`) closes the sockets that the revoked `jti` admitted. The close code is new: `4012` ("Token revoked; re-authenticate"). Other tokens of the same key stay open.
- **Key-moving doors** close, with `4010`, every socket whose token would no longer verify under the key that admitted it. The check is resolved per device and key, the same way the verifier resolves it. This covers accept-migration, which can overwrite a returning identity's registry and holder key; the receipt heal, which moves the registry fallback; and pairing's `update-key`. `update-key` used to close by key alone, so it also disconnected another device whose row held the same claiming key.

Master-token sockets, and sockets on relays with device auth off, stay open, because none of these doors refuses them. Each door takes its close port as a required dependency and calls it after its writes. A revocation or token revocation that lands while a socket's token is still being verified is refused at registration and recorded (`agent_revoked_during_verification` and `jti_blacklisted_during_verification`).
