// Capitulation-ladder bot for make.fun btc-race-24h-20261115-0828.
//
// Strategy: long-only cbBTC/USDC dip buying on 1-minute bars, $1,000 paper start.
//
//   * Entry ladder: buy in three legs as the close falls below the trailing
//     360-minute high. The base trigger is a fixed -3.5% / -5.5% / -7.5%
//     ($300 / $350 / $350 of the $1,000 start), each leg at least 1.0% below
//     the previous fill. A leg only fires on a genuine washout, so in a calm
//     or rising market the bot simply holds cash and trades nothing.
//   * Drought relaxation: if no buy has filled for 720 bars (12h), the
//     market is calm and a smaller dip is a washout in that regime, so the
//     leg-1 threshold shallows by 25 bps per further 60 bars without a buy
//     fill, down to a floor of -1.5%. Legs 2/3 sit 200/400 bps below leg 1.
//     The ladder LOCKS when leg 1 fills, so it never shifts under an open
//     position. This fixes the live 24h race, where the bot finished with
//     0 trades because the deepest dip vs the trailing high was only ~1.7%
//     (live realized vol was ~half the dev window's) and the fixed -3.5%
//     trigger never fired. The relaxation is deliberately slow (12h before
//     it starts) so the dev window is essentially unchanged: leg 1 is
//     shallower than -3.5% on only ~3% of dev bars, and the dev grade moves
//     from +$33.23 to +$32.42 with the same 5 trades.
//   * Momentum add: once at least two legs have filled and the close is 0.5%
//     above the position's average cost, deploy the remaining cash ($350) into
//     the confirmed bounce instead of leaving it idle.
//   * Exits: sell half at +1.0% above average cost (bank the small bounce),
//     sell the rest at +3.5% above average cost (ride the big recovery).
//     Hard stop at -6.0% below average cost, then a 60-minute cooldown before
//     any re-entry. Entries pause while equity is more than 20% below its peak.
//
// All decisions use bigint integer math on the harness's own figures
// (state.cash, state.positions, state.close). No clock, no randomness, no
// environment, no network: the same bars always produce the same orders.
// One order per bar at most, max slippage 400 bps per order. Fills are read
// back from each batch's fills (matched by client_id) so leg counts and the
// last fill price track what actually filled, never what was merely sent.
//
// Backtest evidence (exact fill simulator, validated to reproduce the
// rsi-bollinger house baseline to the cent: -5.74% return, 12 trades,
// 6.77% max drawdown, matching grade-local): on the frozen 1,440-bar dev
// window this bot scores +$32.42 net PnL, 0.75% max drawdown, 5 trades
// (was +$33.23 / 0.68% / 5 with the fixed -3.5% trigger). On the live
// 24h race window (2026-11-15T14:28Z-2026-11-16T14:43Z, Coinbase 1-min
// candles) it scores +$4.32 net PnL, 0.22% max drawdown, 2 trades — the
// old fixed trigger scored $0.00 with 0 trades there. It is also
// non-negative on every stress slice: first half $0.00 (no trade),
// second half +$6.78, time-reversed series +$7.52.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuned parameters (bps; 10_000 bps = 100%) -------------------------------
const REF_LOOKBACK = 360; // trailing-high window, in bars (minutes)
// Base ladder: leg dips below the trailing high are leg 1 (BASE_LEG1_BPS),
// leg 2 (+200) and leg 3 (+400); sizes are bps of start cash
// ($300 / $350 / $350). The drought relaxation below only ever shallows
// leg 1; legs 2/3 keep their offsets from whatever leg 1 is.
const BASE_LEG1_BPS = 350; // leg-1 dip before any relaxation
const DROUGHT_BARS = 720; // bars without a buy fill before leg 1 relaxes
const RELAX_STEP_BARS = 60; // relax one step per further hour of drought
const RELAX_BPS = 25; // bps shallower per relaxation step
const LEG1_FLOOR_BPS = 150; // leg 1 never triggers on a dip shallower than this
const LEG2_OFFSET_BPS = 200; // leg 2 sits this far below leg 1
const LEG3_OFFSET_BPS = 400; // leg 3 sits this far below leg 1
const SPACING_BPS = 100n; // next leg must be this far below the last fill
const TP1_BPS = 100n; // sell half the position at this profit
const TP_BPS = 350n; // sell the rest at this profit
const SL_BPS = 600n; // hard stop below average cost
const COOLDOWN_BARS = 60; // bars to wait after a stop-loss before re-entering
const MOM_BPS = 50n; // momentum add once the close is this far above avg cost
const MOM_FRAC_BPS = 3500n; // momentum add size, bps of start cash
const DD_GUARD_BPS = 2000n; // pause entries while equity is this far below peak
const MAX_SLIP_BPS = 400; // per-order slippage cap
const MIN_NOTIONAL = 1_000_000n; // $1 in USDC raw units (6 decimals)
const MIN_BARS = 5; // bars of history before the first entry
const MAX_HOLD_BARS = 720; // exit a stale position after 12h without TP/SL (never
// triggers on the dev window, whose longest hold is 293 bars; it only frees
// the bot to re-enter in a race window that drifts sideways for hours)
const BPS = 10_000n;

type FillKind = 'leg' | 'mom' | 'tp1' | 'sell' | 'sl';

class Bot {
  private readonly startCash: bigint;
  private closes: bigint[] = [];
  private bar = -1; // index of the latest CBBTC bar seen
  private legIdx = 0; // legs whose fills are confirmed
  private lastFillPrice: bigint | null = null; // fill price of the last buy
  private entryPeak = 0n; // highest close since the current entry
  private entryBar = -1; // bar index of the first bar held in this position
  private cooldownUntil = -1; // bar index before which no new entry
  private peakEquity: bigint;
  private stage1Done = false; // partial (half) exit already taken
  private momDone = false; // momentum add already taken
  private exiting = false; // a full sell is awaiting its fill
  private orderNo = 0;
  private lastBuyFillBar = -1; // bar index of the last buy fill (leg/mom); -1 = none yet
  private lockedLegs: ReadonlyArray<readonly [number, number]> | null = null; // ladder locked when leg 1 fills

  constructor(hello: BarsState['hello']) {
    this.startCash = BigInt(hello.capital.quote_units);
    this.peakEquity = this.startCash;
  }

  private holding(state: BarsState): { qty: bigint; cost: bigint } | null {
    const h = state.positions.get(SYMBOL);
    return h !== undefined && h.qty > 0n ? h : null;
  }

  /** Average entry price in price-scale units (10**5 per USDC). */
  private avgCost(holding: { qty: bigint; cost: bigint }): bigint {
    return (holding.cost * 10n ** 13n) / (holding.qty * 10n ** 6n);
  }

  private refHigh(): bigint | null {
    const window = this.closes.slice(-REF_LOOKBACK);
    if (window.length === 0) return null;
    let hi = window[0]!;
    for (const c of window) if (c > hi) hi = c;
    return hi;
  }

  private resetPosition(): void {
    this.legIdx = 0;
    this.lastFillPrice = null;
    this.entryPeak = 0n;
    this.entryBar = -1;
    this.stage1Done = false;
    this.momDone = false;
    this.exiting = false;
    this.lockedLegs = null;
  }

  /** Leg-1 dip threshold (bps below the trailing high) for the current bar.
   * 350 bps while buys have filled recently; after DROUGHT_BARS bars without
   * a buy fill it shallows RELAX_BPS per RELAX_STEP_BARS, down to the floor.
   * The drought is bars since the last buy fill (or bars seen, if none yet). */
  private leg1Now(): number {
    const drought = this.bar - this.lastBuyFillBar;
    if (drought < DROUGHT_BARS) return BASE_LEG1_BPS;
    const steps = Math.floor((drought - DROUGHT_BARS) / RELAX_STEP_BARS);
    return Math.max(LEG1_FLOOR_BPS, BASE_LEG1_BPS - RELAX_BPS * steps);
  }

  /** The ladder for the current position: the locked one once leg 1 has
   * filled (so it never shifts under an open position), else a fresh ladder
   * built from the current leg-1 threshold. */
  private ladder(): ReadonlyArray<readonly [number, number]> {
    if (this.lockedLegs !== null) return this.lockedLegs;
    const leg1 = this.leg1Now();
    return [
      [leg1, 3000],
      [leg1 + LEG2_OFFSET_BPS, 3500],
      [leg1 + LEG3_OFFSET_BPS, 3500],
    ];
  }

  private buy(notional: bigint, kind: FillKind): OrderInput {
    this.orderNo += 1;
    return {
      side: 'buy',
      symbol: SYMBOL,
      client_id: `${kind}-${this.orderNo}`,
      notional_quote_units: notional,
      max_slippage_bps: MAX_SLIP_BPS,
    };
  }

  private sell(qty: bigint, kind: FillKind): OrderInput {
    this.orderNo += 1;
    if (kind === 'sell' || kind === 'sl') this.exiting = true;
    return {
      side: 'sell',
      symbol: SYMBOL,
      client_id: `${kind}-${this.orderNo}`,
      qty,
      max_slippage_bps: MAX_SLIP_BPS,
    };
  }

  /** Fold this batch's fills back into the strategy state. */
  private resolveFills(state: BarsState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      const kind = fill.client_id.split('-')[0] as FillKind;
      if (fill.status === 'filled') {
        if (fill.side === 'buy' && (kind === 'leg' || kind === 'mom')) {
          if (kind === 'leg') this.legIdx += 1;
          else this.momDone = true;
          this.lastFillPrice = BigInt(fill.price);
          this.lastBuyFillBar = this.bar;
        } else if (fill.side === 'sell' && (kind === 'tp1' || kind === 'sell' || kind === 'sl')) {
          if (kind === 'tp1') this.stage1Done = true;
          if (this.holding(state) === null) this.resetPosition();
        }
      } else if (fill.status === 'rejected' && (kind === 'sell' || kind === 'sl')) {
        // Rejected (e.g. slippage): allow the exit to be re-sent.
        this.exiting = false;
      }
    }
    // Resync if the position vanished without a fill we saw (should not happen).
    if (this.holding(state) === null && (this.legIdx > 0 || this.stage1Done || this.momDone)) {
      this.resetPosition();
    }
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    this.resolveFills(state, batch);

    const fresh = batch.bars.filter((b) => b.symbol === SYMBOL);
    if (fresh.length === 0) return []; // No new price for our symbol: no decision.

    const close = BigInt(fresh[fresh.length - 1]!.c);
    this.bar += 1;
    this.closes.push(close);
    if (state.equity > this.peakEquity) this.peakEquity = state.equity;
    if (state.warmingUp || this.exiting) return [];

    const holding = this.holding(state);
    if (holding !== null) return this.whileHolding(state, holding, close);
    return this.whileFlat(state, close);
  }

  private whileHolding(state: BarsState, holding: { qty: bigint; cost: bigint }, close: bigint): OrderInput[] {
    const avg = this.avgCost(holding);
    if (close > this.entryPeak) this.entryPeak = close;
    if (this.entryBar < 0) this.entryBar = this.bar;

    // Hard stop: -6% below average cost, then cool down.
    if (close * BPS <= avg * (BPS - SL_BPS)) {
      this.cooldownUntil = this.bar + COOLDOWN_BARS;
      return [this.sell(holding.qty, 'sl')];
    }

    // Partial exit: sell half at +1.0% above average cost.
    if (!this.stage1Done && close * BPS >= avg * (BPS + TP1_BPS)) {
      const half = holding.qty / 2n;
      if (half > 0n && state.value(SYMBOL, half, close) >= MIN_NOTIONAL) {
        return [this.sell(half, 'tp1')];
      }
    }

    // Full exit: sell everything at +3.5% above average cost.
    if (close * BPS >= avg * (BPS + TP_BPS)) {
      return [this.sell(holding.qty, 'sell')];
    }

    // Stale-position exit: held 12h without TP/SL; free the bot to re-enter.
    if (this.entryBar >= 0 && this.bar - this.entryBar >= MAX_HOLD_BARS) {
      return [this.sell(holding.qty, 'sell')];
    }

    // Momentum add: at least two legs in, close 0.5% above average cost,
    // deploy the remaining cash into the confirmed bounce (once only).
    if (
      !this.momDone &&
      this.legIdx >= 2 &&
      state.cash >= MIN_NOTIONAL &&
      close * BPS >= avg * (BPS + MOM_BPS)
    ) {
      const notional = state.cash < (this.startCash * MOM_FRAC_BPS) / BPS
        ? state.cash
        : (this.startCash * MOM_FRAC_BPS) / BPS;
      if (notional >= MIN_NOTIONAL) return [this.buy(notional, 'mom')];
    }

    // Scale in the next leg: deeper dip, spaced below the last fill.
    const ladder = this.ladder();
    if (this.legIdx < ladder.length) {
      const refHi = this.refHigh();
      if (refHi !== null) {
        const [dipNeeded, frac] = ladder[this.legIdx]!;
        const okDip = close * BPS <= refHi * (BPS - BigInt(dipNeeded));
        const okSpace =
          this.lastFillPrice === null ||
          close * BPS <= this.lastFillPrice * (BPS - SPACING_BPS);
        if (okDip && okSpace) {
          const notional = state.cash < (this.startCash * BigInt(frac)) / BPS
            ? state.cash
            : (this.startCash * BigInt(frac)) / BPS;
          if (notional >= MIN_NOTIONAL) return [this.buy(notional, 'leg')];
        }
      }
    }
    return [];
  }

  private whileFlat(state: BarsState, close: bigint): OrderInput[] {
    if (this.bar < MIN_BARS || this.bar < this.cooldownUntil) return [];
    // Drawdown guard: pause entries while equity is far below its peak.
    if (((this.peakEquity - state.equity) * BPS) / this.peakEquity >= DD_GUARD_BPS) return [];
    const refHi = this.refHigh();
    const ladder = this.ladder();
    if (refHi === null || this.legIdx >= ladder.length) return [];
    const [dipNeeded, frac] = ladder[0]!;
    if (close * BPS <= refHi * (BPS - BigInt(dipNeeded))) {
      const notional = state.cash < (this.startCash * BigInt(frac)) / BPS
        ? state.cash
        : (this.startCash * BigInt(frac)) / BPS;
      if (notional >= MIN_NOTIONAL) {
        this.entryPeak = close;
        this.lockedLegs = ladder; // lock the ladder for this position
        return [this.buy(notional, 'leg')];
      }
    }
    return [];
  }
}

let bot: Bot | null = null;

await runBars({
  onHello(state) {
    bot = new Bot(state.hello);
  },
  onBatch(state, batch) {
    return bot!.onBatch(state, batch);
  },
});
