# Quant Trader Interview Engine

`packages/local-compute` now exposes a standalone, deterministic market-making interview subsystem. It does not depend on the generic interview/session runtime or on any model/provider.

## Public API

Create an engine with `createQuantTraderScenario(config)` (or construct `QuantTraderInterviewEngine` directly), then drive it through:

1. `getState()` - inspect the current fair value, market state, portfolio/risk state, public market events, deterministic history, and the current quote request.
2. `submitQuote(quote)` - validate and stage a two-sided student quote.
3. `submitAction(action)` - stage either a `QUOTE` action or a deterministic `PASS`.
4. `advance()` - simulate one order-flow step, match through the existing `LimitOrderBook`, apply fills through the existing `PortfolioTracker`, mark the portfolio, check risk, and emit round evidence.
5. `getResult()` - after completion, return deterministic objective metrics, accounting checks, score data, and the full evidence history.

Invalid lifecycle actions and invalid quotes fail with `QuantTraderActionError`; the engine does not silently clip or repair student actions. Runtime scenario configuration is parsed strictly (including booleans, safe integer counts, probabilities, risk consistency, and fair-value schedules), and accepted inputs are copied so caller mutation cannot change a running scenario.

Round advancement is transactional. If order-book matching, accounting, mark-to-market, risk evaluation, or evidence construction throws, the engine restores its PRNG state, logical ID/time counters, book, portfolio, counters, history, and the already-submitted action. Retrying the same staged action therefore follows the same deterministic path instead of consuming a different random branch.

## Scenario families

- `BASIC_MARKET_MAKING` - repeated two-sided quoting around a stable fair value.
- `FAIR_VALUE_UPDATES` - public fair-value changes, generated reproducibly from the seed unless an explicit update schedule is supplied.
- `INVENTORY_PRESSURE` - directionally skewed noise flow that tends to build inventory.
- `ADVERSE_SELECTION` - elevated informed flow that picks off quotes outside fair value.
- `RISK_MANAGEMENT` - smaller hard position limits and stop-on-breach behavior.

All family defaults can be overridden through scenario configuration without changing the runtime API.

## Determinism

The engine owns a `SeededRandom` instance and never calls global randomness. The same scenario configuration, seed, and accepted student-action sequence therefore produce the same order-flow decisions and evidence.

The existing `LimitOrderBook` accepts optional clock/ID hooks. The interview engine supplies logical timestamps and deterministic IDs, so fill/order metadata is reproducible as well as prices, quantities, inventory, cash, and P&L. Default order-book behavior remains wall-clock/UUID based for existing callers.

`MarketMakerSimulator` also accepts an optional random source, and its existing scoring formula is factored into `calculateMarketMakingScore` so the interview engine reuses the same objective scoring primitive rather than maintaining a competing calculation.

## Accounting and risk

Every accepted fill is processed by `PortfolioTracker`. Round evidence exposes cash, position, realized P&L, unrealized P&L, total P&L, mark-to-market portfolio value, drawdown, and trade count. Evidence and final results also report whether:

`portfolioValue == initialCash + totalPnL`

within floating-point tolerance.

Configured hard position limits are checked before a quote is accepted against either side's worst-case fill. Stop-loss/drawdown/position checks are also evaluated after fills and after public fair-value updates. Risk scenarios can stop immediately after a breach.

## Deliberately deferred

This package does not add `QUANT_TRADER` to session start commands, persistence, server routing, UI, adaptive interviewing, provider calls, Socratic policy, or natural-language grading. A later integration task should treat this engine as a deterministic domain service and translate its state/evidence into the generic interview runtime.
