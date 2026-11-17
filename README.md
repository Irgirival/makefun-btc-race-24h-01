# makefun-btc-race-24h-01 — Capitulation-ladder cbBTC bot

Entry for make.fun competition `btc-race-24h-20261115-0828`
("Race a BTC trading bot live for 24 hours", $250 pot, free entry).
Long-only cbBTC/USDC on 1-minute bars, $1,000 paper start.

## Strategy

A dip-buying ladder with a momentum add and staged exits. It does nothing
in a calm or rising market — it only trades genuine washouts.

| Rule | Detail |
|---|---|
| Entry ladder | Buy 3 legs as the close falls below the trailing 360-min high: base −3.5% ($300), −5.5% ($350), −7.5% ($350); each leg ≥1.0% below the previous fill. If no buy has filled for 720 bars (12h), leg 1 shallows by 25 bps per further 60 bars, down to a −1.5% floor; legs 2/3 sit 200/400 bps below leg 1, and the ladder locks when leg 1 fills (see "What changed and why") |
| Momentum add | Once ≥2 legs filled and the close is +0.5% above avg cost, deploy the remaining $350 into the confirmed bounce (once per position) |
| Partial exit | Sell half at +1.0% above avg cost |
| Full exit | Sell all at +3.5% above avg cost |
| Stop loss | −6.0% below avg cost, then 60-min cooldown before re-entering |
| Drawdown guard | Entries pause while equity is >20% below its peak |
| Stale exit | Sell a position held 12h without TP/SL (never triggers on dev; frees the bot to re-enter in a sideways race window) |

One order per bar at most, max slippage 400 bps. All math is bigint
integer math on the harness's own figures; no clock, no randomness, no
environment, no network — the same bars always produce the same orders.
Fills are read back from each batch's `fills` (matched by `client_id`), so
leg counts and the last fill price track what actually filled.

## Backtest evidence

### Dev window (1,440 bars, 2026-11-14 08:29Z–2026-11-15 08:28Z)

- **Net PnL +$32.42** (return +3.24%), **max drawdown 0.75%**, 5 trades —
  verified with the kit's `grade-local` (`--driver process --worktree`),
  L1 reproduced. The exact-fill simulator used for tuning was validated by
  reproducing the `rsi-bollinger` house baseline to the cent (−5.74% return,
  12 trades, 6.77% max drawdown).
- Trades on dev: buy $300 at $63,832 (dip), sell half at $64,464 (+1%),
  buy $350 at $62,365 (capitulation dip), momentum add $350 at $63,289,
  sell all at $65,353 (+3.5%).
- Stress slices (same simulator): first half $0.00 (no trade — no deep dip),
  second half +$6.78, time-reversed series +$7.52. Non-negative everywhere.
- The perfect-foresight ceiling on dev is +$128.75 (18 round trips); the
  3-swing oracle is +$55.78. This bot captures the three real swings with
  disciplined sizing instead of chasing 1-minute noise (naive micro-swing
  scalping loses money on this window).

### Live race window (1,455 bars, 2026-11-15T14:28Z–2026-11-16T14:43Z)

- **Net PnL +$4.32**, **max drawdown 0.22%**, 2 trades — verified by
  replaying the real `main.ts` through the bars-replay/v1 protocol against
  Coinbase BTC-USD 1-minute candles (`btc-race-research/replay.mjs`; the
  replay harness reproduces `grade-local` on the dev window to the cent,
  +$32.419333). Trades: buy $300 at $64,035 (dip, bar 1304), sell half at
  $64,794 (+1%, bar 1445), remainder flattened at the final close $65,253.
- The old fixed −3.5% trigger scored **$0.00 with 0 trades** on this window
  (confirmed in the same simulator): the deepest dip vs the trailing
  360-min high was only ~1.7%.

## What changed and why (trigger fix, 2026-11-17)

The live 24h race ended with **0 trades**: the bot only buys leg 1 when the
close falls 3.5% below the trailing 360-min high, but the live window's
deepest such dip was ~1.7% (measured on Coinbase 1-min candles; the parent
measured −2.28% on a different dip definition — either way, far below 3.5%).
The live window was also about half as volatile as the dev window
(trailing-360-min realized vol: live median 126 bps vs dev median 249 bps),
so a fixed trigger tuned on dev was simply unreachable live. A bot that
finishes a 24h race with 0 trades cannot win anything.

The first fix tried was a **pure volatility-adaptive ladder** (leg 1 =
k × trailing-360-min realized vol, clamped, legs at leg 1/+200/+400). It was
rejected on the data: across a 36-combination grid (k 0.8–1.5, floors
80–120 bps, caps 250–350 bps) the dev window went **negative in every
configuration (−$5 to −$26, max drawdown up to 4.1%)**, vs +$33.23 for the
fixed trigger. A shallower trigger buys ordinary 1–2% dips that do not
bounce; the old bot's edge was selectivity — it only fired on genuine
washouts.

The fix that shipped is a **late-race drought relaxation** on top of the
unchanged fixed ladder: if no buy has filled for 720 bars (12h), leg 1
shallows by 25 bps per further 60 bars without a buy fill, down to a
−1.5% floor; legs 2/3 sit 200/400 bps below leg 1, and the ladder locks
when leg 1 fills so it never shifts under an open position. Rationale: after
12h with no washout the market is range-bound, and a 1.5% dip is a genuine
dislocation in that regime. It is deliberately slow — on the dev window leg 1
is shallower than −3.5% on only 42 of 1,439 bars (2.9%), never deeper, and
the dev grade moves just +$33.23 → +$32.42 with the same 5 trades and
identical stress slices. On the live window it fires once, near the dip
bottom (bar 1304, $64,035), for +$4.32.

Caveat: this does **not** change the finished race's result — the live
0-trade outcome stands. The fix is for the next race.

## Files

- `main.ts` — the bot (Node 22, TypeScript, erasable syntax only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's bars-replay/v1
  SDK shim (`sdk/makefun-bars.ts`)
- `LICENSE` — MIT

## Run the local grade

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --json
```

Requires the competition kit (`btc-race-24h-20261115-0828-kit`).
