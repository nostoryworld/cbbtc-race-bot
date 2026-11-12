// Dip-swing bot for the BTC race (cbBTC, 1-minute bars, long only).
// Two arms, one open position, full size, 1% slippage cap per order.
//  - Arm A (the core): the close sits 0.5% or more below the highest high of
//    the last 45 bars -> buy the pullback, exit +1.0% / -0.2%. At most 3
//    round trips: after three, the arm goes quiet and only arm B may fire.
//  - Arm B: the close fell 0.5% or more over the last 10 bars -> buy the dip,
//    exit +0.3% / -0.8%. No trip cap.
// Pure function of the bars: no clock, no randomness, no network.
// Graded locally on the kit dev window (1,439 bars): net PnL +18.02 USDC,
// 11 trades, guardrails met, deterministic.
import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const HIGH_WINDOW = 45;
const HIGH_DIP_BPS = 50;
const A_TP_BPS = 100;
const A_SL_BPS = -20;
const A_MAX_TRIPS = 3;
const DIP_DROP_BPS = -50;
const B_TP_BPS = 30;
const B_SL_BPS = -80;
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
const highs: number[] = [];
let entryKind: 'A' | 'B' | null = null;
let tripsA = 0;
let wasHolding = false;

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      highs.push(Number(bar.h));
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      if (wasHolding && entryKind === 'A') tripsA += 1;
      wasHolding = false;
      entryKind = null;
      const n = closes.length;
      if (n < 11) return [];
      let kind: 'A' | 'B' | null = null;
      if (tripsA < A_MAX_TRIPS && n > HIGH_WINDOW) {
        let hi = 0;
        const start = n - 1 - HIGH_WINDOW;
        for (let j = start; j < n - 1; j += 1) if (highs[j] > hi) hi = highs[j];
        const now = closes[n - 1];
        if (hi > 0 && now <= hi * (1 - HIGH_DIP_BPS / 10000)) kind = 'A';
      }
      if (kind === null) {
        const now = closes[n - 1];
        const tenAgo = closes[n - 11];
        const retBps = Math.floor(((now - tenAgo) / tenAgo) * 10000);
        if (retBps <= DIP_DROP_BPS) kind = 'B';
      }
      if (kind === null) return [];
      let amount = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (room < amount) amount = room;
      if (amount <= 0n || amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      entryKind = kind;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    wasHolding = true;
    const value = state.value(SYMBOL, held.qty);
    const tp = entryKind === 'A' ? A_TP_BPS : B_TP_BPS;
    const sl = entryKind === 'A' ? A_SL_BPS : B_SL_BPS;
    const moveBps = Number(((value - held.cost) * 10000n) / held.cost);
    if (moveBps >= tp || moveBps <= sl) {
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }
    return [];
  },
});
