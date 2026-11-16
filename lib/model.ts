// token-radar-01: the value model. One snapshot of the protocol universe in, one ranked board out.
//
// The board is the watchlist plus every other pre-token protocol the snapshot carries (above the floor
// or below it): the watchlist is the floor the house drew, never a ceiling, and the early rows below it
// are exactly the launches a radar exists to find. Every row is scored by one function of the snapshot's
// own figures — no protocol name is ever special-cased, no row is hand-picked.
//
//   base     = BASE_SCALE x tvl_usd ^ TVL_EXP                 (square root: size helps, giants do not run away)
//   growth   = clamp(change_7d, GROWTH_FLOOR, GROWTH_CAP) per cent
//   gMult    = max(GROWTH_MIN, 1 + growth / 100 x GROWTH_WEIGHT)   (never zero, never negative)
//   mMult    = MATURITY_FLOOR + min(age_days, MATURITY_DAYS) / MATURITY_DAYS x MATURITY_RANGE
//   implied  = max(1, round(base x gMult x mMult))
//
// `age_days` is the whole days from the snapshot's as_of back to listed_at — the snapshot's own record of
// how long the protocol has run with no token. A row whose age is unknown uses UNKNOWN_AGE_DAYS.
//
// Token status is the snapshot's own test: a protocol is 'pre-token' when it records no market cap, no
// CoinGecko id and no symbol; anything else already trades and is set aside with the market's own value.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string; // YYYY-MM-DD
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[]; // slugs, ascending
}

/** The model's constants, stated in the dashboard and changeable in the model sandbox. */
export interface ModelConstants {
  base_scale: number;
  tvl_exponent: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  growth_min: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

/** The house model. base_scale is chosen so a $100M protocol lands near $20k of implied value. */
export const MODEL: ModelConstants = {
  base_scale: 20,
  tvl_exponent: 0.5,
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 150,
  growth_min: 0.1,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The board the dashboard labels itself with. */
export const MODEL_VERSION = 'radar-2';

/** How the formatter names a value on the board. */
export const TOKEN_PRE = 'pre-token';
export const TOKEN_LIVE = 'live';
export type TokenStatus = typeof TOKEN_PRE | typeof TOKEN_LIVE;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A non-empty string, else null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Thresholds the snapshot's own README names for the watchlist rule. The snapshot already applied them;
// the model re-applies them only to decide which *extra* protocols below the floor are worth ranking.
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking, in any case: a product of a token that already trades. */
const WRAPPED = /\b(?:wrapped|staked|staking)\b/i;
const NON_LAUNCH_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIX = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/** Whether a protocol records no token at all: the snapshot's own pre-token test. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The snapshot's token status for a protocol: the board's split. */
export function tokenStatus(p: SnapshotProtocol): TokenStatus {
  return isPreToken(p) ? TOKEN_PRE : TOKEN_LIVE;
}

/**
 * Whether a pre-token protocol is one the radar may rank. A wrapped, staked or bridged product of a token
 * that already trades is not a protocol waiting on a launch of its own, and neither is an exchange or a
 * versioned pool of another protocol. This mirrors the snapshot's watchlist rule so that the extra rows
 * the radar adds are drawn by the same test the house used, never by hand.
 */
export function isLaunchable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && NON_LAUNCH_CATEGORIES.has(p.category)) return false;
  const name = p.name;
  if (VERSIONED.test(name) || WRAPPED.test(name)) return false;
  const lower = name.toLowerCase();
  if (EXCHANGE_PREFIX.some((x) => lower.startsWith(x))) return false;
  return true;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whole days from the snapshot's as_of back to listed_at, clamped at zero; null when either is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export interface ImpliedValue {
  implied: number;
  base_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

/**
 * One protocol's implied value under `model`. Every input is a snapshot field: TVL sets the base, the
 * seven-day change scales it up or down, and the days since the protocol was first listed scale it by
 * maturity. The result is always a positive whole dollar amount.
 */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants = MODEL): ImpliedValue {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = Math.max(model.growth_min, 1 + (growthPct / 100) * model.growth_weight);
  const ageForModel = Math.min(Math.max(age ?? model.unknown_age_days, 0), model.maturity_days);
  const maturityMult = model.maturity_floor + (ageForModel / model.maturity_days) * model.maturity_range;
  const base = model.base_scale * Math.pow(Math.max(protocol.tvl_usd, 0), model.tvl_exponent);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return {
    implied,
    base_usd: Math.round(base),
    growth_pct: round4(growthPct),
    growth_multiplier: round4(growthMult),
    maturity_multiplier: round4(maturityMult),
    age_days: age,
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A farm move: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One ranked row: the snapshot's own fields plus the model's reading of them. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  on_watchlist: boolean;
  below_floor: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    model_version: string;
    base_scale: number;
    tvl_exponent: number;
    base_usd: number;
    growth_pct: number;
    growth_weight: number;
    growth_multiplier: number;
    maturity_multiplier: number;
  };
  farm_steps: string[];
}

/** The compact row the dashboard renders (farm steps are regenerated in the page from the same fields). */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  token_status: string;
  on_watchlist: boolean;
  below_floor: boolean;
  age_days: number | null;
  implied_value_usd: number;
  base_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  symbol: string | null;
  farm_steps: string[];
}

/** A protocol that already trades: the board shows the market's own number, never the model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: string;
  farm_steps: string[];
}

/** Everything the dashboard needs: the ranked board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  pre_token_total: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

const DEFAULT_EARLY_ROWS = 320;

/** The protocols the board ranks: the watchlist first, then every other launchable pre-token protocol. */
function selectProtocols(snapshot: Snapshot, earlyRows: number): { chosen: Map<string, SnapshotProtocol>; watch: Set<string> } {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) if (!index.has(p.slug)) index.set(p.slug, p);
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it is ranked, whatever the snapshot's other fields say.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Every other launchable pre-token protocol, biggest TVL first, up to the early cap. Nothing already
  // chosen is displaced, and the cap only bounds absurd snapshots, never this one.
  const extra = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isLaunchable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || byCodeUnit(a.slug, b.slug))
    .slice(0, earlyRows);
  for (const p of extra) chosen.set(p.slug, p);
  return { chosen, watch };
}

/** The live-token protocols, by market cap, set aside from the ranked board. */
export function liveRows(snapshot: Snapshot, cap = 24): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || byCodeUnit(a.slug, b.slug))
    .slice(0, cap)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      symbol: p.symbol,
      listed_at: p.listed_at,
      age_days: ageDays(snapshot.as_of, p.listed_at),
      token_status: TOKEN_LIVE,
      farm_steps: farmSteps(p, ageDays(snapshot.as_of, p.listed_at)).map(stepText),
    }));
}

/** A step as one line: its action, then its cost and time. Kept inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 && p.chains[0] !== undefined && p.chains[0] !== '' ? p.chains[0] : 'its main chain';
}

/** How much capital one position needs, from the protocol's own TVL. */
export function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 250;
  if (tvlUsd >= 1_000_000_000) return 150;
  if (tvlUsd >= 100_000_000) return 100;
  if (tvlUsd >= 20_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: a young protocol gets a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in words a farmer can follow. No name is special-cased. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('options')) return `Sell or buy $${capital} of options on ${name} and keep the receipt.`;
  if (c.includes('index')) return `Buy $${capital} of the index through ${name} on ${chain} and hold it.`;
  if (c.includes('payment') || c.includes('card')) return `Load $${capital} through ${name} and make one qualifying transaction on ${chain}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a concrete cost and time. The plan is derived
 * from the protocol's own record — category, chains, TVL, age — never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 9 : capital >= 100 ? 6 : 4;
  const weekly = capital >= 150 ? 3 : 2;
  const valueLine = Math.max(1, Math.round((p.tvl_usd / 1e6) * 0.02));
  return [
    {
      text: `Create a fresh wallet that holds only this farm's funds, fund it from a source you can document, and keep its seed phrase offline.`,
      cost: `under $3 of gas for the first transaction`,
      time: `5 minutes`,
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about $${gas} of gas`,
      time: `15 minutes to set up`,
    },
    {
      text: `Record the entry in a farm log — the wallet, the date, the pool or market and the deposit — so the position can be repeated or unwound later.`,
      cost: `nothing but the log`,
      time: `5 minutes`,
    },
    {
      text: `Make one qualifying action each week on ${p.name}, such as a deposit, a borrow, a swap or a governance vote, and log each one.`,
      cost: `about $${weekly} of gas a week`,
      time: `10 minutes a week`,
    },
    {
      text: `Hold the position at least ${hold} days so its activity is counted in more than one weekly snapshot of ${p.name}'s TVL, now around $${valueLine}M in scale.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before withdrawing, open ${p.name}'s own points or rewards page, claim only from the link it publishes, and never pay a fee to claim.`,
      cost: `no fee to check, and never pay to claim`,
      time: `10 minutes`,
    },
    {
      text: `Unwind on a scheduled date — withdraw to a stable asset, note the realised cost of $${capital} plus gas, and keep the log for the next cycle.`,
      cost: `about $${gas} of gas to exit`,
      time: `15 minutes`,
    },
  ];
}

/** A row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    token_status: row.token_status,
    on_watchlist: row.on_watchlist,
    below_floor: row.below_floor,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_usd: row.model.base_usd,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    symbol: row.symbol,
    farm_steps: row.farm_steps,
  };
}

/** The ranked board and the live set, from the snapshot. */
export interface BuiltRadar {
  board: BoardRow[];
  radar: RadarData;
}

/**
 * Score every pre-token protocol the radar covers and rank them by implied value. Ties fall back to slug,
 * so the board is deterministic; ranks are 1..N and unique.
 */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL, earlyRows = DEFAULT_EARLY_ROWS): BuiltRadar {
  const { chosen, watch } = selectProtocols(snapshot, earlyRows);
  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || byCodeUnit(a.p.slug, b.p.slug));

  const board = scored.map((s, i): BoardRow => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: TOKEN_PRE,
    on_watchlist: watch.has(s.p.slug),
    below_floor: s.p.tvl_usd < snapshot.floor_usd,
    age_days: s.v.age_days,
    implied_value_usd: s.v.implied,
    model: {
      model_version: MODEL_VERSION,
      base_scale: model.base_scale,
      tvl_exponent: model.tvl_exponent,
      base_usd: s.v.base_usd,
      growth_pct: s.v.growth_pct,
      growth_weight: model.growth_weight,
      growth_multiplier: s.v.growth_multiplier,
      maturity_multiplier: s.v.maturity_multiplier,
    },
    farm_steps: farmSteps(s.p, s.v.age_days).map(stepText),
  }));

  const live = liveRows(snapshot);
  const preTokenTotal = snapshot.protocols.filter(isPreToken).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    pre_token_total: preTokenTotal,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isFinite(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i): SnapshotProtocol => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

const isSafePosInt = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/**
 * Why a board is not one the gate will take, or null. Checks coverage, rank uniqueness and order, that
 * implied values are positive whole dollars and never rise with rank, that pre-token rows really are
 * pre-token, and that farm steps land in the gate's length band.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (new Set(board.map((r) => r.slug)).size !== board.length) return 'the board repeats a slug';
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.token_status !== TOKEN_PRE) return `${r.slug} is ${r.token_status} on the pre-token board`;
    if (!isSafePosInt(r.implied_value_usd)) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const steps = r.farm_steps;
    if (steps.length < 5 || steps.length > 8) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData, globalName = 'RADAR'): string {
  return `window.${globalName}=${JSON.stringify(radar)};\n`;
}
