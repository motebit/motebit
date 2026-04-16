# @motebit/circuit-breaker

Per-peer forward-health state machine. Three states (closed, open, half_open), sliding-window failure counting, probe-on-recovery. Generic enough for any outbound-call guard — federation forwards today, MCP client retries and webhook delivery next.

Layer 1. BSL-1.1. Zero internal deps, zero I/O. The clock is injected; the logger is optional.

## Rules

1. **No I/O.** Pure state machine. If you need to fetch, time out, or schedule — do it at the consumer. The package must stay trivially testable with deterministic time.
2. **Clock is pluggable, never `Date.now()` by default in tests.** `new CircuitBreaker({ now: () => fakeClock })` is the only way to exercise the OPEN → HALF_OPEN timeout in a unit test.
3. **Logger is injectable and structured.** `CircuitBreakerLogger.info(event, data)`. Events are dotted strings (`circuit_breaker.state_change`, `circuit_breaker.reset`). No message concatenation; consumers join into their own correlation-id context.
4. **Peer identity is opaque.** The `peerId` argument is a string the caller chooses (endpoint URL, DID, DNS name). The breaker does not parse or validate it — per-peer isolation is the only semantic invariant.
5. **Transitions are logged; steady-state polling is not.** `canForward` and `getState` never emit log events. A 1000 QPS forward path must not generate 1000 log lines.
6. **Coverage floor is 100/100/100/100.** The state machine is small enough that every branch is testable; regressions block.

## What NOT to add

- Persistence. If callers want to survive restarts, they persist `getAllStates()` externally and seed a fresh instance on boot.
- Async APIs. Every method is synchronous. Callers compose it inside their own promise chains.
- Per-peer config overrides. The three-state semantics are shared across all peers by design; if a caller genuinely needs different thresholds per peer, they instantiate multiple breakers.

## Consumers

- `services/api` — federation forward health (`task-routing.ts`). See Rule 7 of `services/api/CLAUDE.md`.
