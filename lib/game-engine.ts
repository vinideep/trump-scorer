export type Direction = 'CW' | 'ACW';

export interface PlayerRef {
  id: number;
  name: string;
}

export interface RoundRecord {
  roundNumber: number; // 1..19
  cards: number;
  bids: number[];      // length 5, indexed by seat 0..4
  won: number[];       // length 5, indexed by seat 0..4
}

export interface GameRecord {
  id: number;
  players: PlayerRef[];
  first_player_idx: number;
  initial_dir: Direction;
  rounds: RoundRecord[];
  status: 'active' | 'completed';
  winner_names: string[];
  created_at: string;
  updated_at: string;
}

export const ROUND_CARDS: readonly number[] = [
  10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
  2, 3, 4, 5, 6, 7, 8, 9, 10,
];

export const SUBTOTAL_AFTER_ROUNDS = new Set([5, 10, 15, 18]);

export interface RoundMeta {
  roundIdx: number;      // 0..18
  roundNumber: number;   // 1..19
  cards: number;
  isReversed: boolean;
  activeDir: Direction;
  step: 1 | -1;
  starterIdx: number;    // 0..4
  serverIdx: number;     // 0..4
  turnOrder: number[];   // 5 seat indices in play order (starter first, server last)
}

/**
 * Rounds 1–10 (idx 0..9): Always step +1 through seats (Player 5 serves to Player 1),
 * regardless of whether initialDir is CW or ACW.
 * Rounds 11–19 (idx 10..18): Reverses direction (CW <-> ACW) and steps -1 right after Round 10.
 */
export function getRoundMeta(
  roundIdx: number,
  firstPlayerIdx: number,
  initialDir: Direction
): RoundMeta {
  const isReversed = roundIdx >= 10;
  const activeDir: Direction = isReversed
    ? initialDir === 'CW'
      ? 'ACW'
      : 'CW'
    : initialDir;
  const step: 1 | -1 = isReversed ? -1 : 1;

  let starterIdx: number;
  if (!isReversed) {
    starterIdx = (firstPlayerIdx + roundIdx) % 5;
  } else {
    const round10Starter = (firstPlayerIdx + 9) % 5;
    const stepsBack = roundIdx - 9; // Round 11 -> 1 step back
    starterIdx = (((round10Starter - stepsBack) % 5) + 5) % 5;
  }

  // Server sits immediately before the starter in the active turn order (plays 5th)
  const serverIdx = (((starterIdx - step) % 5) + 5) % 5;

  const turnOrder: number[] = [];
  for (let i = 0; i < 5; i++) {
    turnOrder.push((((starterIdx + i * step) % 5) + 5) % 5);
  }

  return {
    roundIdx,
    roundNumber: roundIdx + 1,
    cards: ROUND_CARDS[roundIdx],
    isReversed,
    activeDir,
    step,
    starterIdx,
    serverIdx,
    turnOrder,
  };
}

export function scoreEntry(bid: number, won: number): { delta: number; notation: string; hit: boolean } {
  if (won === bid) {
    return { delta: bid, notation: `${bid}+${bid}`, hit: true };
  }
  const diff = Math.abs(bid - won);
  return { delta: -diff, notation: `${bid}-${diff}`, hit: false };
}

export function computeTotals(rounds: RoundRecord[], upToCount = rounds.length): number[] {
  const totals = [0, 0, 0, 0, 0];
  for (let r = 0; r < Math.min(upToCount, rounds.length); r++) {
    const round = rounds[r];
    for (let p = 0; p < 5; p++) {
      totals[p] += scoreEntry(round.bids[p], round.won[p]).delta;
    }
  }
  return totals;
}

export function formatSigned(n: number): string {
  if (n > 0) return `+${n}`;
  return `${n}`;
}

export function getWinners(players: PlayerRef[], rounds: RoundRecord[]): string[] {
  if (rounds.length < 19) return [];
  const totals = computeTotals(rounds);
  const max = Math.max(...totals);
  return players.filter((_, idx) => totals[idx] === max).map((p) => p.name);
}
