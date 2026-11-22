import type { PlayerRef } from './game-engine';

export interface RummyRoundRecord {
  dealNumber: number; // 1, 2, ...
  scores: number[];   // penalty points for this deal (0..80) for each player
  types: ('show' | 'drop' | 'middle' | 'full' | 'manual' | 'out')[];
}

export interface RummyGameRecord {
  id: number;
  game_type: 'rummy240';
  players: PlayerRef[];
  rounds: RummyRoundRecord[];
  status: 'active' | 'completed';
  winner_names: string[];
  created_at: string;
  updated_at: string;
}

export const RUMMY_MAX_POINTS = 240;
export const RUMMY_FULL_COUNT = 80;
export const RUMMY_FIRST_DROP = 20;
export const RUMMY_MIDDLE_DROP = 40;

export interface PlayerRummyStatus {
  player: PlayerRef;
  cumulativeScore: number;
  isEliminated: boolean;
  dealsWon: number;
  dropsCount: number;
  fullCounts: number;
}

/**
 * Computes running cumulative scores for each player deal-by-deal.
 */
export function computeRummyTotals(players: PlayerRef[], rounds: RummyRoundRecord[], upToCount = rounds.length): number[] {
  const totals = new Array(players.length).fill(0);
  for (let r = 0; r < Math.min(upToCount, rounds.length); r++) {
    const round = rounds[r];
    for (let p = 0; p < players.length; p++) {
      totals[p] += round.scores[p] ?? 0;
    }
  }
  return totals;
}

/**
 * Returns player statuses including elimination status (score >= 240).
 */
export function getRummyPlayerStatuses(players: PlayerRef[], rounds: RummyRoundRecord[]): PlayerRummyStatus[] {
  const totals = computeRummyTotals(players, rounds);
  return players.map((p, idx) => {
    let dealsWon = 0;
    let dropsCount = 0;
    let fullCounts = 0;

    for (const rd of rounds) {
      const type = rd.types[idx];
      const sc = rd.scores[idx];
      if (sc === 0 || type === 'show') dealsWon++;
      if (type === 'drop' || type === 'middle') dropsCount++;
      if (sc >= 80 || type === 'full') fullCounts++;
    }

    return {
      player: p,
      cumulativeScore: totals[idx],
      isEliminated: totals[idx] >= RUMMY_MAX_POINTS,
      dealsWon,
      dropsCount,
      fullCounts,
    };
  });
}

/**
 * Checks if the game is completed (only 1 or 0 non-eliminated players remain).
 */
export function isRummyGameCompleted(players: PlayerRef[], rounds: RummyRoundRecord[]): boolean {
  if (rounds.length === 0) return false;
  const statuses = getRummyPlayerStatuses(players, rounds);
  const activePlayers = statuses.filter((s) => !s.isEliminated);
  return activePlayers.length <= 1;
}

/**
 * Returns the winners of the Rummy 240 game.
 */
export function getRummyWinners(players: PlayerRef[], rounds: RummyRoundRecord[]): string[] {
  if (rounds.length === 0) return [];
  const statuses = getRummyPlayerStatuses(players, rounds);
  const active = statuses.filter((s) => !s.isEliminated);

  if (active.length === 1) {
    return [active[0].player.name];
  }

  // If all are eliminated somehow, lowest cumulative score wins
  const minScore = Math.min(...statuses.map((s) => s.cumulativeScore));
  return statuses.filter((s) => s.cumulativeScore === minScore).map((s) => s.player.name);
}
