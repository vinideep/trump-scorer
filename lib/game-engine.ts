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

export const SUBTOTAL_CHECKPOINTS: Record<number, string> = {
  4: 'Subtotal (R1–5)',
  9: 'Subtotal (R1–10)',
  14: 'Subtotal (R1–15)',
  17: 'Subtotal (R1–18)',
  18: 'FINAL TOTAL',
};

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

export function scoreEntry(bid: number, won: number): { delta: number; notation: string; status: 'hit' | 'zero' | 'miss'; hit: boolean } {
  if (won === bid) {
    return { delta: bid, notation: `${bid}+${bid}`, status: bid === 0 ? 'zero' : 'hit', hit: true };
  }
  const diff = Math.abs(bid - won);
  return { delta: -diff, notation: `${bid}-${diff}`, status: 'miss', hit: false };
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

export interface RankedPlayer {
  idx: number;
  name: string;
  score: number;
  rank: number;
  exactHits: number;
  misses: number;
}

export function rankPlayers(players: PlayerRef[], totals: number[], rounds: RoundRecord[]): RankedPlayer[] {
  const items = players.map((p, idx) => {
    let exactHits = 0;
    let misses = 0;
    for (const r of rounds) {
      if (r.won[idx] === r.bids[idx]) exactHits++;
      else misses++;
    }
    return { idx, name: p.name, score: totals[idx], rank: 1, exactHits, misses };
  });

  items.sort((a, b) => b.score - a.score || b.exactHits - a.exactHits || a.idx - b.idx);

  let currentRank = 1;
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && items[i].score < items[i - 1].score) {
      currentRank = i + 1;
    }
    items[i].rank = currentRank;
  }
  return items;
}

export interface MatchHighlights {
  mostExact: { names: string; count: number };
  bestRound: { delta: number; player: string; roundNum: number; notation: string };
  bestJump: { gain: number; player: string; label: string; from: number; to: number };
  cleanestStreak: { names: string; streak: number; misses: number; fewestMissesGlobal: number };
}

export function computeHighlights(players: PlayerRef[], rounds: RoundRecord[]): MatchHighlights | null {
  if (!rounds.length) return null;

  const exactCounts = [0, 0, 0, 0, 0];
  const missCounts = [0, 0, 0, 0, 0];
  const bestStreaks = [0, 0, 0, 0, 0];
  const curStreaks = [0, 0, 0, 0, 0];

  let bestRound = { delta: -999, player: players[0].name, roundNum: 1, notation: '0+0' };

  rounds.forEach((rd, rIdx) => {
    for (let p = 0; p < 5; p++) {
      const res = scoreEntry(rd.bids[p], rd.won[p]);
      if (res.delta > bestRound.delta) {
        bestRound = { delta: res.delta, player: players[p].name, roundNum: rIdx + 1, notation: res.notation };
      }
      if (res.hit) {
        exactCounts[p]++;
        curStreaks[p]++;
        if (curStreaks[p] > bestStreaks[p]) bestStreaks[p] = curStreaks[p];
      } else {
        missCounts[p]++;
        curStreaks[p] = 0;
      }
    }
  });

  const maxExact = Math.max(...exactCounts);
  const exactWinners = players.filter((_, i) => exactCounts[i] === maxExact).map((p) => p.name);

  const maxStreak = Math.max(...bestStreaks);
  const streakIdx = bestStreaks.indexOf(maxStreak);
  const minMisses = Math.min(...missCounts);
  const cleanestWinners = players.filter((_, i) => bestStreaks[i] === maxStreak).map((p) => p.name);

  const runningTotalsByRound: number[][] = [];
  const running = [0, 0, 0, 0, 0];
  for (const r of rounds) {
    for (let p = 0; p < 5; p++) {
      running[p] += scoreEntry(r.bids[p], r.won[p]).delta;
    }
    runningTotalsByRound.push([...running]);
  }

  const segments = [
    { label: 'R1–R5', fromIdx: -1, toIdx: 4 },
    { label: 'R6–R10', fromIdx: 4, toIdx: 9 },
    { label: 'R11–R15', fromIdx: 9, toIdx: 14 },
    { label: 'R16–R19', fromIdx: 14, toIdx: 18 },
    { label: '2nd Half (R11–R19)', fromIdx: 9, toIdx: 18 },
  ];

  let bestJump = { gain: -999, player: players[0].name, label: 'R11–R19', from: 0, to: 0 };
  segments.forEach((seg) => {
    if (rounds.length > seg.toIdx) {
      const prevTotals = seg.fromIdx >= 0 ? runningTotalsByRound[seg.fromIdx] : [0, 0, 0, 0, 0];
      const endTotals = runningTotalsByRound[seg.toIdx];
      for (let p = 0; p < 5; p++) {
        const gain = endTotals[p] - prevTotals[p];
        if (gain > bestJump.gain) {
          bestJump = { gain, player: players[p].name, label: seg.label, from: prevTotals[p], to: endTotals[p] };
        }
      }
    }
  });

  return {
    mostExact: { names: exactWinners.join(', '), count: maxExact },
    bestRound,
    bestJump,
    cleanestStreak: {
      names: cleanestWinners.join(', '),
      streak: maxStreak,
      misses: missCounts[streakIdx],
      fewestMissesGlobal: minMisses,
    },
  };
}
