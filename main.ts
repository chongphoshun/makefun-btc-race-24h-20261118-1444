// BTC 24h race bot: deep-dip reversal + washout all-in. Long only, Node 22, stdlib only.
//
// ONE CONCEPT: buy only the deepest dips, and ride the snap-back. Nothing else.
// The bot sits in cash almost all the time. It buys only when the price has
// fallen hard against its own recent range AND the bounce has already started,
// then it holds for the snap-back and gets out. No scalping, no trend-chasing,
// no breakout entries, no re-entry right after a trade.
//
// Why this shape: the previous entry (rank 775/1333, -2.66%, 14 trades) lost
// because it traded too often - a shallow -0.5%/30m dip trigger plus a
// breakout mode fired on every wiggle of a choppy market, and the small
// losses piled up. The winners of that race did the opposite: 2-6 trades,
// all-in on a washout (BTC down ~4.5%), held for the +2.4% snap-back.
// This bot copies the winners' shape and removes the loser's two mistakes:
//   * the dip must be DEEP (measured against the 4-hour high, not a 30-min
//     wiggle), so ordinary chop never triggers a trade;
//   * there is no breakout mode - in a range-bound market every breakout is
//     a false one, and buying it is how you overtrade;
//   * a cooldown after every trade stops the bot from re-entering the same
//     chop twice in a row.
//
// Two entry modes, both full-size (100% of cash), one position at a time:
//
//   A) Dip reversal: the close is DIP below the highest close of the prior
//      240 minutes (4 hours) AND the 10-minute return is above BOUNCE_10M
//      (the bounce has started) AND the 5-minute return is above 0 (the
//      bounce is still alive). Buys the start of a recovery leg after a real
//      dip, not noise.
//   B) Washout all-in: the 120-minute return is below WASHOUT_120M (a deep
//      multi-hour capitulation) AND the 10-minute return is above
//      BOUNCE_10M. Buys the washout itself. The take-profit and stops are
//      wider here, because a washout's snap-back is bigger than a normal
//      dip's. On the dev window this never fires (its deepest 120-min drop
//      is -2.27%, vs the -2.5% trigger); it exists for the race window,
//      where the winners' +2.4% snap-backs live.
//
// Exits (per entry, whole position):
//   - Take profit at TAKE_PROFIT over the entry close (mode A) or
//     WASHOUT_TP (mode B). A full round trip costs ~0.4% (4 bps fee +
//     2 bps slippage + ~13 bps impact per side), so the take-profit must
//     clear that with room to spare.
//   - Trailing stop TRAIL_STOP below the highest close since entry, so a
//     snap-back that keeps running is ridden, and a fading one is exited
//     near its peak.
//   - Hard stop HARD_STOP below the entry close (mode A) or WASHOUT_STOP
//     (mode B): the dip was not the bottom, cut it.
//   - Cooldown: after any sell, no new buy for COOLDOWN bars.
//
// Protocol: agent-fun/bars-replay/v1 via the kit's TypeScript shim (vendored
// byte-identical under vendor/). One reply per batch, deterministic: only
// float arithmetic on the bar closes, no clock, no randomness, no I/O.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- entry parameters ---
// Grid-searched on the dev window (see TEST-REPORT.md). DIP=-0.012 is the
// shallow end of a flat plateau: deep enough to skip the chop, shallow
// enough to still fire a few times in a flat race window. Shallower
// (-0.008/-0.010) loses by trading noise. BOUNCE_10M=0.002 is the stronger
// bounce filter: it fires only once the dip has actually turned.
const RANGE_BARS = 240; // mode A: rolling high window (bars)
const DIP = -0.012; // mode A: close DIP below the 240-bar high
const BOUNCE_10M = 0.002; // both modes: 10-min return above this
const BOUNCE_5M = 0.0; // mode A: 5-min return above this
const WASHOUT_120M = -0.025; // mode B: 120-min return below this
const COOLDOWN = 60; // bars to wait after a sell before the next buy

// --- exit parameters ---
const TAKE_PROFIT = 0.008; // mode A: +0.8% over the entry close
const TRAIL_STOP = 0.007; // mode A: 0.7% below the peak close since entry
const HARD_STOP = 0.008; // mode A: 0.8% below the entry close
const WASHOUT_TP = 0.02; // mode B: +2.0% over the entry close
const WASHOUT_TRAIL = 0.01; // mode B: 1.0% below the peak close since entry
const WASHOUT_STOP = 0.012; // mode B: 1.2% below the entry close

const MAX_SLIPPAGE_BPS = 200; // 2%: the largest 1-min move in the dev window is 66 bps

class Bot {
  closes: number[] = []; // closes (float USD) in bar order, fresh bars only
  entryClose: number | null = null; // close of the bar the current position was decided on
  peak: number | null = null; // highest close since entry
  mode: 'A' | 'B' | null = null;
  pending: { entryClose: number; mode: 'A' | 'B' } | null = null; // buy sent, awaiting confirmation
  cooldownUntil = -1; // closes.length before which no new buy

  ret(barsBack: number): number | null {
    const n = this.closes.length;
    if (n <= barsBack) return null;
    const now = this.closes[n - 1];
    const then = this.closes[n - 1 - barsBack];
    return now / then - 1.0;
  }

  high(barsBack: number): number | null {
    // Highest close of the prior `barsBack` closes, excluding the current one.
    const window = this.closes.slice(-1 - barsBack, -1);
    if (window.length < barsBack) return null;
    return Math.max(...window);
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    if (fresh) {
      const c = state.close(SYMBOL);
      if (c !== null) this.closes.push(Number(c) / 1e5);
    }
    if (state.warmingUp || !fresh) return [];

    const close = this.closes[this.closes.length - 1];
    const held = state.positions.get(SYMBOL);

    // Confirm a pending buy once the position actually appears; drop it
    // if the buy was rejected (no position on the next batch).
    if (held !== undefined) {
      if (this.pending !== null) {
        this.entryClose = this.pending.entryClose;
        this.mode = this.pending.mode;
        this.peak = close;
        this.pending = null;
      }
      if (this.entryClose === null) {
        this.entryClose = close;
        this.mode = 'A';
        this.peak = close;
      }
    } else {
      if (this.entryClose !== null) {
        // A position just closed: start the cooldown.
        this.cooldownUntil = this.closes.length + COOLDOWN;
      }
      this.entryClose = null;
      this.peak = null;
      this.mode = null;
      this.pending = null;
    }

    if (held === undefined) return this.maybeBuy(state, close);

    // --- holding: exits ---
    if (this.peak !== null && close > this.peak) this.peak = close;
    const entry = this.entryClose as number;
    const peak = this.peak as number;
    const tp = this.mode === 'B' ? WASHOUT_TP : TAKE_PROFIT;
    const trail = this.mode === 'B' ? WASHOUT_TRAIL : TRAIL_STOP;
    const stop = this.mode === 'B' ? WASHOUT_STOP : HARD_STOP;
    if (close >= entry * (1.0 + tp)) return this.sell(state);
    if (close <= peak * (1.0 - trail)) return this.sell(state);
    if (close <= entry * (1.0 - stop)) return this.sell(state);
    return [];
  }

  maybeBuy(state: BarsState, close: number): OrderInput[] {
    if (this.closes.length < this.cooldownUntil) return [];
    const r10 = this.ret(10);
    if (r10 === null || r10 <= BOUNCE_10M) return [];
    let mode: 'A' | 'B' | null = null;
    // Mode B first: a deep washout outranks an ordinary dip.
    const r120 = this.ret(120);
    if (r120 !== null && r120 < WASHOUT_120M) {
      mode = 'B';
    } else {
      const hi = this.high(RANGE_BARS);
      const r5 = this.ret(5);
      if (hi !== null && r5 !== null && close / hi - 1.0 < DIP && r5 > BOUNCE_5M) {
        mode = 'A';
      }
    }
    if (mode === null) return [];
    const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    this.pending = { entryClose: close, mode };
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  sell(state: BarsState): OrderInput[] {
    const held = state.positions.get(SYMBOL);
    if (held === undefined || held.qty <= 0n) return [];
    return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

const bot = new Bot();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
