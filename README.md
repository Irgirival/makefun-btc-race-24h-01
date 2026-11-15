# makefun-btc-race-24h-01 — Capitulation-ladder cbBTC bot

Entry for make.fun competition `btc-race-24h-20261115-0828`
("Race a BTC trading bot live for 24 hours", $250 pot, free entry).
Long-only cbBTC/USDC on 1-minute bars, $1,000 paper start.

## Strategy

A dip-buying ladder with a momentum add and staged exits. It does nothing
in a calm or rising market — it only trades genuine washouts.

| Rule | Detail |
|---|---|
| Entry ladder | Buy 3 legs as the close falls below the trailing 360-min high: −3.5% ($300), −5.5% ($350), −7.5% ($350); each leg ≥1.0% below the previous fill |
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

## Backtest evidence (dev window, 1,440 bars, 2026-11-14 08:29Z–2026-11-15 08:28Z)

- **Net PnL +$33.23** (return +3.32%), **max drawdown 0.68%**, 5 trades —
  verified with the kit's `grade-local` (`--driver process`), L1 reproduced.
  The exact-fill simulator used for tuning was validated by reproducing the
  `rsi-bollinger` house baseline to the cent (−5.74% return, 12 trades,
  6.77% max drawdown).
- Trades on dev: buy $300 at $63,789 (dip), sell half at $64,356 (+1%),
  buy $350 at $62,160 (capitulation dip), momentum add $350 at $63,450,
  sell all at $65,458 (+3.5%).
- Stress slices (same simulator): first half $0.00 (no trade — no deep dip),
  second half +$6.78, time-reversed series +$7.52. Non-negative everywhere.
- The perfect-foresight ceiling on dev is +$128.75 (18 round trips); the
  3-swing oracle is +$55.78. This bot captures the three real swings with
  disciplined sizing instead of chasing 1-minute noise (naive micro-swing
  scalping loses money on this window).

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
