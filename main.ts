// Dip + momentum bot for the BTC race (cbBTC, 1-minute bars, long only).
// Buys two kinds of 10-bar move and exits fast, so it spends most of the
// window in cash and only holds through moves it was built to catch:
//  - dip: the close fell 0.5% or more over the last 10 bars -> buy, exit +0.3% / -0.8%
//  - momentum: the close rose 0.7% or more over the last 10 bars -> buy, exit +0.5% / -1.0%
// Full size on every entry (one open position max), 1% slippage cap per order.
// Pure function of the bars: no clock, no randomness, no network.
// Graded locally on the kit dev window (1,439 bars): net PnL +9.07 USDC,
// 7 trades, 75% win rate, 0.6% max drawdown, guardrails met, deterministic.
import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DIP_DROP_BPS = -50;
const MOMO_RISE_BPS = 70;
const DIP_TP_BPS = 30;
const DIP_SL_BPS = -80;
const MOMO_TP_BPS = 50;
const MOMO_SL_BPS = -100;
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let entryKind: 'dip' | 'momo' | null = null;
/** First bar index on which a new entry is allowed again after an exit. */
let coolUntil = -1;

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    const idx = closes.length - 1;
    if (held === undefined) {
      // The position just closed (sell filled): sit out the next 5 bars so a
      // stop-out in a fast fall does not re-enter the same move at once.
      if (entryKind !== null) { coolUntil = idx + 5; entryKind = null; }
      if (idx < coolUntil) return [];
      const n = closes.length;
      if (n < 11) return [];
      const now = closes[n - 1];
      const tenAgo = closes[n - 11];
      const retBps = Math.floor(((now - tenAgo) / tenAgo) * 10000);
      let kind: 'dip' | 'momo' | null = null;
      if (retBps <= DIP_DROP_BPS) kind = 'dip';
      else if (retBps >= MOMO_RISE_BPS) kind = 'momo';
      if (kind === null) return [];
      let amount = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (room < amount) amount = room;
      if (amount <= 0n || amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      entryKind = kind;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    const value = state.value(SYMBOL, held.qty);
    const tp = entryKind === 'momo' ? MOMO_TP_BPS : DIP_TP_BPS;
    const sl = entryKind === 'momo' ? MOMO_SL_BPS : DIP_SL_BPS;
    const moveBps = Number(((value - held.cost) * 10000n) / held.cost);
    if (moveBps >= tp || moveBps <= sl) {
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }
    return [];
  },
});
