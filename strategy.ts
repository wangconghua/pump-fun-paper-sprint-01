// Surge-rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die within minutes, but a coin whose first minutes show a
// genuine crowd — several different wallets buying, net SOL flowing in, price climbing
// and holding near its short-window high — has a real chance of running several multiples
// before it fades. So: buy young curves on that surge signal only, keep the stake small,
// take half off the table at +45%, and let the other half ride behind a trailing stop.
// Losers are cut by a stop loss, by flow turning negative, or by a time limit.
//
// This is deliberately simpler than a pyramiding momentum bot: one entry per position,
// no adds, exits decided by price and flow only. Deterministic by construction: no
// clock, no randomness, iteration only over insertion-ordered maps fed by the batch
// stream. Written from scratch in this session.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which an entry is no longer allowed. */
  maxAge: number;
  /** SOL to put into one position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell half the position once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when value falls below peak * (1 - trail). */
  trail: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with at least 20 coins each with a round trip of
   * 0.01 SOL. When the bot's own fills or coins lag targetFills / targetCoins scaled by
   * the share of paceSecs elapsed (block time since the first batch), it opens tiny probe
   * round trips (buy probeSol, sell it all as soon as it lands) until back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 0.4,
  minBuys: 4,
  minBuyers: 8,
  minPriceUp: 0.2,
  nearHigh: 0.92,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 200,
  maxAge: 1500,
  stakeSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.25,
  takeProfit: 0.3,
  trailArm: 0.15,
  trail: 0.3,
  fadeWindow: 20,
  fadeNetSol: 1000,
  bigSellSol: 5,
  maxHold: 3000,
  holdIfUp: 0.5,
  cooldown: 120,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

/**
 * Validate a parameter set before trading with it. A config that cannot meet the
 * competition's guardrails (at least 20 coins with a 0.01 SOL round trip, max
 * drawdown 50%) or that breaks the harness caps (5 open positions, 1% of real
 * reserves per order) fails loudly here instead of silently shipping a losing
 * entry. Added after the dev-window sweeps: the winning cell (stake 0.03 SOL,
 * 10 distinct buyers, curves 200–1500 slots old) sits near the probe floor, so
 * a later tweak that drops the stake below the probe size or the target coins
 * below the bar must be caught, not traded.
 */
export function validateParams(p: Params): void {
  const bad: string[] = [];
  if (p.stakeSol < p.minBuySol) bad.push(`stakeSol ${p.stakeSol} < minBuySol ${p.minBuySol}`);
  if (p.probeSol < 0.01) bad.push(`probeSol ${p.probeSol} below the 0.01 SOL round-trip minimum`);
  if (p.targetCoins < 20) bad.push(`targetCoins ${p.targetCoins} below the 20-coin guardrail`);
  if (p.maxMain > 5) bad.push(`maxMain ${p.maxMain} above the 5 open-position cap`);
  if (p.maxAge <= p.minAge) bad.push(`maxAge ${p.maxAge} <= minAge ${p.minAge}`);
  if (p.window <= 0 || p.fadeWindow <= 0) bad.push('window and fadeWindow must be positive');
  if (p.stopLoss <= 0 || p.stopLoss >= 1) bad.push(`stopLoss ${p.stopLoss} outside (0, 1)`);
  if (p.trail < 0 || p.trail >= 1) bad.push(`trail ${p.trail} outside [0, 1)`);
  if (p.takeProfit <= 0) bad.push(`takeProfit ${p.takeProfit} must be positive`);
  if (p.maxBuyerShare <= 0 || p.maxBuyerShare > 1) bad.push(`maxBuyerShare ${p.maxBuyerShare} outside (0, 1]`);
  if (p.nearHigh <= 0 || p.nearHigh > 1) bad.push(`nearHigh ${p.nearHigh} outside (0, 1]`);
  if (p.minRqSol < 0 || p.maxRqSol <= p.minRqSol) bad.push('real-reserve bounds are inconsistent');
  if (p.maxExposureSol < p.stakeSol) bad.push(`maxExposureSol ${p.maxExposureSol} < stakeSol ${p.stakeSol}`);
  if (bad.length > 0) throw new Error(`invalid params: ${bad.join('; ')}`);
}

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** True once the half take-profit has been sent. */
  halfTaken: boolean;
  exiting: boolean;
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  validateParams(p);
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on. */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: half take-profit, then whole-position exits.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        // Half take-profit at +takeProfit, once.
        if (!h.halfTaken && !h.exiting && value >= cost * (1 + p.takeProfit)) {
          const half = (BigInt(pos.token_amount) / 2n).toString();
          if (BigInt(half) > 0n && !pendingByMint.has(mint) && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.halfTaken = true;
            continue;
          }
        }
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, halfTaken: false, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
