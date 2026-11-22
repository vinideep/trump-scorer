'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  computeHighlights,
  computeTotals,
  formatSigned,
  getRoundMeta,
  getWinners,
  rankPlayers,
  ROUND_CARDS,
  scoreEntry,
  SUBTOTAL_CHECKPOINTS,
  type Direction,
  type GameRecord,
  type PlayerRef,
  type RoundRecord,
} from '@/lib/game-engine';
import {
  computeRummyTotals,
  getRummyPlayerStatuses,
  getRummyWinners,
  isRummyGameCompleted,
  RUMMY_FIRST_DROP,
  RUMMY_FULL_COUNT,
  RUMMY_MAX_POINTS,
  RUMMY_MIDDLE_DROP,
  type RummyRoundRecord,
} from '@/lib/rummy-engine';

interface RosterPlayer {
  id: number;
  name: string;
  gamesPlayed: number;
  wins: number;
}

type SelectedGameType = 'trump' | 'rummy240';
type ScreenMode = 'setup' | 'play' | 'gameover' | 'history';
type ViewTab = 'play' | 'sheet';
type TrumpPhase = 'bidding' | 'scoring';

interface UniversalGameRecord {
  id: number;
  game_type: 'trump' | 'rummy240';
  players: PlayerRef[];
  first_player_idx: number;
  initial_dir: Direction;
  rounds: unknown[];
  status: 'active' | 'completed';
  winner_names: string[];
  created_at: string;
  updated_at: string;
}

export default function CardGameScorerApp() {
  const [selectedGameType, setSelectedGameType] = useState<SelectedGameType>('trump');
  const [screen, setScreen] = useState<ScreenMode>('setup');
  const [viewTab, setViewTab] = useState<ViewTab>('play');
  const [historyFilter, setHistoryFilter] = useState<'all' | 'trump' | 'rummy240'>('all');

  // Database state
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [games, setGames] = useState<UniversalGameRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [toast, setToast] = useState<{ msg: string; tone: 'dark' | 'success' | 'error' } | null>(null);

  // Setup state (Trump: exactly 5; Rummy: 2..6)
  const [trumpSeats, setTrumpSeats] = useState<string[]>(['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5']);
  const [trumpStarterIndex, setTrumpStarterIndex] = useState<number>(0);
  const [trumpInitialDirection, setTrumpInitialDirection] = useState<Direction>('CW');

  const [rummySeats, setRummySeats] = useState<string[]>(['Player 1', 'Player 2', 'Player 3', 'Player 4']);
  const [rummyDealerIndex, setRummyDealerIndex] = useState<number>(0);

  const [newPlayerName, setNewPlayerName] = useState('');
  const [manageRoster, setManageRoster] = useState(false);

  // Active game state
  const [activeGame, setActiveGame] = useState<UniversalGameRecord | null>(null);

  // Trump active states
  const [trumpPhase, setTrumpPhase] = useState<TrumpPhase>('bidding');
  const [trumpActivePlayerIdx, setTrumpActivePlayerIdx] = useState<number>(0);
  const [trumpBids, setTrumpBids] = useState<(number | null)[]>([null, null, null, null, null]);
  const [trumpWons, setTrumpWons] = useState<(number | null)[]>([null, null, null, null, null]);

  // Rummy active states
  const [rummyScores, setRummyScores] = useState<(number | null)[]>([null, null, null, null]);
  const [rummyTypes, setRummyTypes] = useState<('show' | 'drop' | 'middle' | 'full' | 'manual' | 'out')[]>([
    'manual',
    'manual',
    'manual',
    'manual',
  ]);
  const [rummyActivePlayerIdx, setRummyActivePlayerIdx] = useState<number>(0);

  // Modals
  const [showSchedule, setShowSchedule] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingRoundIdx, setEditingRoundIdx] = useState<number | null>(null);
  const [editTab, setEditTab] = useState<'bids' | 'wons'>('wons');
  const [editActivePlayer, setEditActivePlayer] = useState<number>(0);
  const [editBids, setEditBids] = useState<number[]>([0, 0, 0, 0, 0]);
  const [editWons, setEditWons] = useState<number[]>([0, 0, 0, 0, 0]);
  const [editRummyScores, setEditRummyScores] = useState<number[]>([]);

  const showToast = useCallback((msg: string, tone: 'dark' | 'success' | 'error' = 'dark') => {
    setToast({ msg, tone });
    setTimeout(() => {
      setToast((curr) => (curr?.msg === msg ? null : curr));
    }, 2500);
  }, []);

  const loadAllData = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, gRes] = await Promise.all([fetch('/api/players'), fetch('/api/games')]);
      const pData = await pRes.json();
      const gData = await gRes.json();
      if (Array.isArray(pData.players)) setRoster(pData.players);
      if (Array.isArray(gData.games)) setGames(gData.games);
    } catch {
      showToast('Could not reach database. Check connection.', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // --- Universal Roster Management ---
  const currentSeats = selectedGameType === 'trump' ? trumpSeats : rummySeats;
  const setCurrentSeats = selectedGameType === 'trump' ? setTrumpSeats : setRummySeats;

  const toggleRosterPlayer = (p: RosterPlayer) => {
    const existingIdx = currentSeats.indexOf(p.name);
    if (existingIdx !== -1) {
      const next = [...currentSeats];
      next[existingIdx] = `Player ${existingIdx + 1}`;
      setCurrentSeats(next);
      return;
    }
    const emptyIdx = currentSeats.findIndex((name, idx) => name === `Player ${idx + 1}` || name.trim() === '');
    if (emptyIdx === -1) {
      showToast('All seat slots are filled. Tap a seat name to replace.', 'dark');
      return;
    }
    const next = [...currentSeats];
    next[emptyIdx] = p.name;
    setCurrentSeats(next);
  };

  const handleAddPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPlayerName.trim();
    if (!trimmed) return;
    setSyncState('saving');
    try {
      const res = await fetch('/api/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to add player', 'error');
        setSyncState('error');
        return;
      }
      setRoster((prev) => [...prev, data.player].sort((a, b) => a.name.localeCompare(b.name)));
      setNewPlayerName('');
      setSyncState('saved');

      const emptyIdx = currentSeats.findIndex((name, idx) => name === `Player ${idx + 1}` || name.trim() === '');
      if (emptyIdx !== -1) {
        const next = [...currentSeats];
        next[emptyIdx] = data.player.name;
        setCurrentSeats(next);
      }
      showToast(`Added "${data.player.name}" to roster`, 'success');
    } catch {
      setSyncState('error');
      showToast('Network error adding player', 'error');
    }
  };

  const handleDeletePlayer = async (p: RosterPlayer) => {
    setSyncState('saving');
    try {
      const res = await fetch(`/api/players/${p.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      setRoster((prev) => prev.filter((item) => item.id !== p.id));
      setCurrentSeats((prev) => prev.map((s) => (s === p.name ? 'Player' : s)));
      setSyncState('saved');
      showToast(`Removed "${p.name}"`, 'dark');
    } catch {
      setSyncState('error');
      showToast('Failed to delete player', 'error');
    }
  };

  const moveSeat = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= currentSeats.length) return;
    const next = [...currentSeats];
    [next[idx], next[target]] = [next[target], next[idx]];
    setCurrentSeats(next);
  };

  const addRummySeat = () => {
    if (rummySeats.length >= 9) {
      showToast('Maximum 9 players allowed in Rummy 240', 'dark');
      return;
    }
    setRummySeats((prev) => [...prev, `Player ${prev.length + 1}`]);
  };

  const removeRummySeat = (idx: number) => {
    if (rummySeats.length <= 2) {
      showToast('Minimum 2 players required for Rummy', 'dark');
      return;
    }
    setRummySeats((prev) => prev.filter((_, i) => i !== idx));
  };

  // --- Start & Resume Game ---
  const handleStartGame = async () => {
    const seatsToUse = selectedGameType === 'trump' ? trumpSeats : rummySeats;
    const players: PlayerRef[] = seatsToUse.map((name, i) => {
      const found = roster.find((r) => r.name.toLowerCase() === name.toLowerCase());
      return { id: found ? found.id : i + 1, name: name.trim() || `Player ${i + 1}` };
    });

    setSyncState('saving');
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_type: selectedGameType,
          players,
          first_player_idx: selectedGameType === 'trump' ? trumpStarterIndex : rummyDealerIndex,
          initial_dir: selectedGameType === 'trump' ? trumpInitialDirection : 'CW',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setActiveGame(data.game);
      setGames((prev) => [data.game, ...prev]);

      if (selectedGameType === 'trump') {
        const meta = getRoundMeta(0, trumpStarterIndex, trumpInitialDirection);
        setTrumpPhase('bidding');
        setTrumpActivePlayerIdx(meta.starterIdx);
        setTrumpBids([null, null, null, null, null]);
        setTrumpWons([null, null, null, null, null]);
      } else {
        setRummyScores(new Array(players.length).fill(null));
        setRummyTypes(new Array(players.length).fill('manual'));
        setRummyActivePlayerIdx(0);
      }

      setScreen('play');
      setViewTab('play');
      setSyncState('saved');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setSyncState('error');
      showToast('Failed to start game in database', 'error');
    }
  };

  const resumeGame = (g: UniversalGameRecord) => {
    setActiveGame(g);
    setSelectedGameType(g.game_type);

    if (g.game_type === 'trump') {
      setTrumpSeats(g.players.map((p) => p.name));
      setTrumpStarterIndex(g.first_player_idx);
      setTrumpInitialDirection(g.initial_dir);

      if (g.rounds.length >= 19) {
        setScreen('gameover');
      } else {
        const meta = getRoundMeta(g.rounds.length, g.first_player_idx, g.initial_dir);
        setTrumpPhase('bidding');
        setTrumpActivePlayerIdx(meta.starterIdx);
        setTrumpBids([null, null, null, null, null]);
        setTrumpWons([null, null, null, null, null]);
        setScreen('play');
        setViewTab('play');
      }
    } else {
      setRummySeats(g.players.map((p) => p.name));
      setRummyDealerIndex(g.first_player_idx);

      const rummyRounds = g.rounds as RummyRoundRecord[];
      if (isRummyGameCompleted(g.players, rummyRounds)) {
        setScreen('gameover');
      } else {
        setRummyScores(new Array(g.players.length).fill(null));
        setRummyTypes(new Array(g.players.length).fill('manual'));
        setRummyActivePlayerIdx(0);
        setScreen('play');
        setViewTab('play');
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const persistUniversalRounds = async (g: UniversalGameRecord, nextRounds: unknown[]) => {
    let status = 'active';
    let winners: string[] = [];

    if (g.game_type === 'rummy240') {
      const rRounds = nextRounds as RummyRoundRecord[];
      status = isRummyGameCompleted(g.players, rRounds) ? 'completed' : 'active';
      winners = getRummyWinners(g.players, rRounds);
    } else {
      const tRounds = nextRounds as RoundRecord[];
      status = tRounds.length >= 19 ? 'completed' : 'active';
      winners = getWinners(g.players, tRounds);
    }

    const optimistic: UniversalGameRecord = {
      ...g,
      rounds: nextRounds,
      status: status as 'active' | 'completed',
      winner_names: winners,
    };

    setActiveGame(optimistic);
    setGames((prev) => prev.map((item) => (item.id === g.id ? optimistic : item)));
    setSyncState('saving');

    try {
      const res = await fetch(`/api/games/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rounds: nextRounds, status, winner_names: winners }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error();
      setActiveGame(data.game);
      setGames((prev) => prev.map((item) => (item.id === g.id ? data.game : item)));
      setSyncState('saved');
      if (data.game.status === 'completed') {
        loadAllData();
      }
    } catch {
      setSyncState('error');
      showToast('Failed to save to database', 'error');
    }
  };

  const handleDeleteGame = async (gameId: number) => {
    try {
      await fetch(`/api/games/${gameId}`, { method: 'DELETE' });
      setGames((prev) => prev.filter((g) => g.id !== gameId));
      if (activeGame?.id === gameId) {
        setActiveGame(null);
        setScreen('setup');
      }
      showToast('Game deleted', 'dark');
    } catch {
      showToast('Failed to delete game', 'error');
    }
  };

  // --- TRUMP Active Round Calculations ---
  const trumpRounds = (activeGame?.rounds ?? []) as RoundRecord[];
  const currentTrumpMeta = useMemo(() => {
    if (!activeGame || activeGame.game_type !== 'trump' || trumpRounds.length >= 19) return null;
    return getRoundMeta(trumpRounds.length, activeGame.first_player_idx, activeGame.initial_dir);
  }, [activeGame, trumpRounds.length]);

  const totalTrumpBids = trumpBids.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const allTrumpBidsDone = trumpBids.every((v) => v !== null);
  const totalTrumpWons = trumpWons.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const allTrumpWonsDone = trumpWons.every((v) => v !== null);

  const confirmTrumpRound = async () => {
    if (!activeGame || !currentTrumpMeta) return;
    if (!allTrumpBidsDone || !allTrumpWonsDone || totalTrumpWons !== currentTrumpMeta.cards) {
      showToast(`Total tricks won is ${totalTrumpWons}, must equal ${currentTrumpMeta.cards}.`, 'error');
      return;
    }

    const newRecord: RoundRecord = {
      roundNumber: currentTrumpMeta.roundNumber,
      cards: currentTrumpMeta.cards,
      bids: trumpBids as number[],
      won: trumpWons as number[],
    };

    const nextRounds = [...trumpRounds, newRecord];
    await persistUniversalRounds(activeGame, nextRounds);

    if (nextRounds.length >= 19) {
      setScreen('gameover');
      showToast('All 19 rounds complete! 🏆', 'success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const nextMeta = getRoundMeta(nextRounds.length, activeGame.first_player_idx, activeGame.initial_dir);
      setTrumpPhase('bidding');
      setTrumpActivePlayerIdx(nextMeta.starterIdx);
      setTrumpBids([null, null, null, null, null]);
      setTrumpWons([null, null, null, null, null]);
      showToast(`Round ${currentTrumpMeta.roundNumber} saved!`, 'success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const undoTrumpRound = async () => {
    if (!activeGame || trumpRounds.length === 0) return;
    const lastRoundNum = trumpRounds.length;
    const popped = trumpRounds[trumpRounds.length - 1];
    const nextRounds = trumpRounds.slice(0, -1);

    await persistUniversalRounds(activeGame, nextRounds);
    const meta = getRoundMeta(nextRounds.length, activeGame.first_player_idx, activeGame.initial_dir);

    setScreen('play');
    setViewTab('play');
    setTrumpPhase('scoring');
    setTrumpActivePlayerIdx(meta.starterIdx);
    setTrumpBids([...popped.bids]);
    setTrumpWons([...popped.won]);
    showToast(`Reopened Round ${lastRoundNum}`);
  };

  // --- RUMMY 240 Active Round Calculations ---
  const rummyRounds = (activeGame?.rounds ?? []) as RummyRoundRecord[];
  const rummyTotals = useMemo(() => {
    if (!activeGame || activeGame.game_type !== 'rummy240') return [];
    return computeRummyTotals(activeGame.players, rummyRounds);
  }, [activeGame, rummyRounds]);

  const rummyStatuses = useMemo(() => {
    if (!activeGame || activeGame.game_type !== 'rummy240') return [];
    return getRummyPlayerStatuses(activeGame.players, rummyRounds);
  }, [activeGame, rummyRounds]);

  const setRummyScoreQuick = (
    pIdx: number,
    val: number,
    type: 'show' | 'drop' | 'middle' | 'full' | 'manual'
  ) => {
    const nextScores = [...rummyScores];
    const nextTypes = [...rummyTypes];
    nextScores[pIdx] = val;
    nextTypes[pIdx] = type;
    setRummyScores(nextScores);
    setRummyTypes(nextTypes);

    // If active player, advance to next active player
    if (activeGame) {
      const numPlayers = activeGame.players.length;
      for (let s = 1; s <= numPlayers; s++) {
        const cand = (pIdx + s) % numPlayers;
        if (!rummyStatuses[cand]?.isEliminated && nextScores[cand] === null) {
          setRummyActivePlayerIdx(cand);
          break;
        }
      }
    }
  };

  const confirmRummyDeal = async () => {
    if (!activeGame || activeGame.game_type !== 'rummy240') return;

    // Check that every non-eliminated player has a score
    for (let i = 0; i < activeGame.players.length; i++) {
      if (!rummyStatuses[i]?.isEliminated && rummyScores[i] === null) {
        showToast(`Please enter score or drop for ${activeGame.players[i].name}`, 'error');
        return;
      }
    }

    // Check if at least one player made a show (0 points)
    const hasShow = rummyScores.some((v, idx) => !rummyStatuses[idx]?.isEliminated && v === 0);
    if (!hasShow) {
      showToast('At least one winner must have Show (0 pts) for the deal', 'error');
      return;
    }

    const roundScores = activeGame.players.map((_, i) =>
      rummyStatuses[i]?.isEliminated ? 0 : (rummyScores[i] ?? 0)
    );
    const roundTypes = activeGame.players.map((_, i) =>
      rummyStatuses[i]?.isEliminated ? 'out' : (rummyTypes[i] ?? 'manual')
    );

    const record: RummyRoundRecord = {
      dealNumber: rummyRounds.length + 1,
      scores: roundScores,
      types: roundTypes,
    };

    const nextRounds = [...rummyRounds, record];
    await persistUniversalRounds(activeGame, nextRounds);

    if (isRummyGameCompleted(activeGame.players, nextRounds)) {
      setScreen('gameover');
      showToast('Rummy match complete! 🏆', 'success');
    } else {
      setRummyScores(new Array(activeGame.players.length).fill(null));
      setRummyTypes(new Array(activeGame.players.length).fill('manual'));
      showToast(`Deal ${record.dealNumber} saved!`, 'success');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const undoRummyDeal = async () => {
    if (!activeGame || rummyRounds.length === 0) return;
    const lastDealNum = rummyRounds.length;
    const popped = rummyRounds[rummyRounds.length - 1];
    const nextRounds = rummyRounds.slice(0, -1);

    await persistUniversalRounds(activeGame, nextRounds);
    setScreen('play');
    setViewTab('play');
    setRummyScores([...popped.scores]);
    setRummyTypes([...popped.types]);
    showToast(`Reopened Deal ${lastDealNum}`);
  };

  // Previews
  const r1Preview = getRoundMeta(0, trumpStarterIndex, trumpInitialDirection);
  const r11Preview = getRoundMeta(10, trumpStarterIndex, trumpInitialDirection);

  const activeSavedGame = games.find(
    (g) => g.status === 'active' && g.game_type === selectedGameType
  );

  return (
    <div className="app-shell">
      {/* =========================================================================
         GLOBAL GAME HUB SELECTOR (Trump vs Rummy 240)
         ========================================================================= */}
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-row">
            <div className="topbar-badges">
              <span className="pill-round">🎴 Card Scorer Pro</span>
              <span className={`pill-dir ${selectedGameType === 'trump' ? 'cw' : 'acw'}`}>
                {selectedGameType === 'trump' ? '🃏 Trump (Judgement)' : '🎴 Rummy 240 Points'}
              </span>
              {syncState === 'saving' && <span className="pill-round" style={{ background: '#f59e0b', color: '#1c1917' }}>Saving…</span>}
              {syncState === 'saved' && <span className="pill-round" style={{ background: '#10b981', color: '#fff' }}>Saved ✓</span>}
            </div>

            <div className="topbar-actions">
              <button
                className="top-icon-btn"
                onClick={() => setScreen('setup')}
                title="New / Setup Game"
              >
                +
              </button>
              <button
                className="top-icon-btn"
                onClick={() => setScreen('history')}
                title="Past Games & Results"
              >
                📜
              </button>
              {activeGame && (
                <button
                  className="top-icon-btn"
                  onClick={() => setShowSettings(true)}
                  title="Options"
                >
                  ⚙
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* =========================================================================
         1. SETUP & GAME SELECTOR SCREEN
         ========================================================================= */}
      {screen === 'setup' && (
        <div className="setup-bg">
          <div className="setup-wrap">
            <div className="brand-header">
              <div className="brand-badge">♣ ♦ Tabletop Scorer Hub ♥ ♠</div>
              <h1 className="brand-title">Select Card Game</h1>
              <p className="brand-sub">Universal database roster · Authentic Indian paper notebook scorer</p>
            </div>

            {/* Game Selector Cards */}
            <div className="hub-grid" style={{ marginBottom: 16 }}>
              <div
                className={`hub-card ${selectedGameType === 'trump' ? 'active' : ''}`}
                onClick={() => setSelectedGameType('trump')}
              >
                <div>
                  <div className="hub-icon">🃏</div>
                  <h3 className="hub-title">Trump (Judgement)</h3>
                  <p className="hub-desc">19 rounds (10→1→10), bidding & tricks, serving order & rotation reversal.</p>
                </div>
                <div className="hub-meta">5 Players · 19 Rounds</div>
              </div>

              <div
                className={`hub-card ${selectedGameType === 'rummy240' ? 'active' : ''}`}
                onClick={() => setSelectedGameType('rummy240')}
              >
                <div>
                  <div className="hub-icon">🎴</div>
                  <h3 className="hub-title">Indian Rummy 240</h3>
                  <p className="hub-desc">240 Pool elimination, 0 show, 20 drop, 40 mid, 80 full count, last man standing.</p>
                </div>
                <div className="hub-meta">2–9 Players · 240 Pts Knockout</div>
              </div>
            </div>

            {/* Resume Banner */}
            {activeSavedGame && (
              <div className="resume-banner">
                <div className="resume-banner-text">
                  <div className="resume-banner-title">Saved {selectedGameType === 'trump' ? 'Trump' : 'Rummy'} Game Active</div>
                  <div className="resume-banner-sub">
                    {activeSavedGame.players.map((p) => p.name).join(', ')} ·{' '}
                    {selectedGameType === 'trump'
                      ? `Round ${activeSavedGame.rounds.length + 1}/19`
                      : `Deal ${activeSavedGame.rounds.length + 1}`}
                  </div>
                </div>
                <button className="btn-resume" onClick={() => resumeGame(activeSavedGame)}>
                  Resume →
                </button>
              </div>
            )}

            <div className="setup-card">
              {/* Seating Order */}
              <div>
                <div className="section-head">
                  <h2 className="section-title">
                    {selectedGameType === 'trump' ? 'Players (5 Seats)' : `Players (${rummySeats.length} Seats)`}
                  </h2>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {selectedGameType === 'rummy240' && (
                      <button className="section-hint" onClick={addRummySeat} disabled={rummySeats.length >= 9}>
                        + Add Seat ({rummySeats.length}/9)
                      </button>
                    )}
                    <button className="section-hint" onClick={() => setManageRoster((v) => !v)}>
                      {manageRoster ? 'Done' : 'Manage Roster'}
                    </button>
                  </div>
                </div>

                <div className="seat-list">
                  {currentSeats.map((name, idx) => (
                    <div key={idx} className="seat-row">
                      <div className="seat-num">{idx + 1}</div>
                      <input
                        type="text"
                        className="seat-input"
                        maxLength={18}
                        value={name}
                        placeholder={`Player ${idx + 1}`}
                        onChange={(e) => {
                          const next = [...currentSeats];
                          next[idx] = e.target.value;
                          setCurrentSeats(next);
                        }}
                      />
                      <div className="reorder-btns">
                        <button
                          className="btn-icon-sm"
                          disabled={idx === 0}
                          onClick={() => moveSeat(idx, -1)}
                          title="Move Up"
                        >
                          ▲
                        </button>
                        <button
                          className="btn-icon-sm"
                          disabled={idx === currentSeats.length - 1}
                          onClick={() => moveSeat(idx, 1)}
                          title="Move Down"
                        >
                          ▼
                        </button>
                        {selectedGameType === 'rummy240' && rummySeats.length > 2 && (
                          <button
                            className="btn-icon-sm"
                            style={{ color: 'var(--rose-600)' }}
                            onClick={() => removeRummySeat(idx)}
                            title="Remove Seat"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Saved Player Roster Chips */}
                {roster.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink-500)', textTransform: 'uppercase' }}>
                      Tap to Select Saved Players ({roster.length}):
                    </div>
                    <div className="roster-grid">
                      {roster.map((player) => {
                        const seatIdx = currentSeats.indexOf(player.name);
                        const isSelected = seatIdx !== -1;
                        return (
                          <div
                            key={player.id}
                            className={`roster-chip ${isSelected ? 'selected' : ''}`}
                            onClick={() => !manageRoster && toggleRosterPlayer(player)}
                          >
                            {isSelected && <span className="chip-seat">#{seatIdx + 1}</span>}
                            <span>{player.name}</span>
                            {player.gamesPlayed > 0 && (
                              <span className="chip-meta">{player.wins}W/{player.gamesPlayed}G</span>
                            )}
                            {manageRoster && (
                              <button
                                className="chip-del"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeletePlayer(player);
                                }}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Add new player */}
                <form className="add-player-row" onSubmit={handleAddPlayer}>
                  <input
                    type="text"
                    className="seat-input"
                    style={{ background: 'var(--bg-subtle)', borderRadius: 10, padding: '7px 10px', fontSize: 13, border: '1px solid var(--border-soft)' }}
                    placeholder="+ Add friend to permanent roster…"
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                    maxLength={32}
                  />
                  <button className="btn-icon-sm" style={{ width: 'auto', padding: '0 12px', fontSize: 13 }} type="submit" disabled={!newPlayerName.trim()}>
                    Add
                  </button>
                </form>
              </div>

              {/* Trump-specific Setup Controls */}
              {selectedGameType === 'trump' && (
                <>
                  <div>
                    <div className="section-head">
                      <h2 className="section-title">Who Goes 1st in Round 1?</h2>
                    </div>
                    <div className="pill-grid-5">
                      {trumpSeats.map((name, idx) => (
                        <button
                          key={idx}
                          className={`starter-pill ${trumpStarterIndex === idx ? 'active' : ''}`}
                          onClick={() => setTrumpStarterIndex(idx)}
                        >
                          <span className="truncate">{name || `P${idx + 1}`}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="section-head">
                      <h2 className="section-title">Initial Rotation Direction</h2>
                    </div>
                    <div className="segmented-2">
                      <button
                        className={`seg-btn ${trumpInitialDirection === 'CW' ? 'active-cw' : ''}`}
                        onClick={() => setTrumpInitialDirection('CW')}
                      >
                        <span>↻ Clockwise</span>
                        <span className="seg-sub">Flips to ↺ ACW after R10</span>
                      </button>
                      <button
                        className={`seg-btn ${trumpInitialDirection === 'ACW' ? 'active-acw' : ''}`}
                        onClick={() => setTrumpInitialDirection('ACW')}
                      >
                        <span>↺ Anti-Clockwise</span>
                        <span className="seg-sub">Flips to ↻ CW after R10</span>
                      </button>
                    </div>
                  </div>

                  <div className="preview-card">
                    <div className="section-head" style={{ marginBottom: 6 }}>
                      <h2 className="section-title">Round 1 Preview (10 Cards)</h2>
                      <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink-500)' }}>
                        {r1Preview.activeDir === 'CW' ? '↻ Clockwise' : '↺ Anti-Clockwise'}
                      </span>
                    </div>
                    <div className="preview-grid">
                      <div className="preview-role server">
                        <div className="preview-role-label">🃏 Serving</div>
                        <div className="preview-role-name truncate">{trumpSeats[r1Preview.serverIdx]}</div>
                      </div>
                      <div className="preview-role first">
                        <div className="preview-role-label">▶ 1st Player</div>
                        <div className="preview-role-name truncate">{trumpSeats[r1Preview.starterIdx]}</div>
                      </div>
                    </div>
                    <div className="order-chain">
                      {r1Preview.turnOrder.map((p) => trumpSeats[p]).join(' → ')}
                    </div>
                  </div>
                </>
              )}

              {/* Rummy 240 Setup Controls */}
              {selectedGameType === 'rummy240' && (
                <>
                  <div>
                    <div className="section-head">
                      <h2 className="section-title">Who Deals 1st Hand?</h2>
                    </div>
                    <div className="pill-grid-5">
                      {rummySeats.map((name, idx) => (
                        <button
                          key={idx}
                          className={`starter-pill ${rummyDealerIndex === idx ? 'active' : ''}`}
                          onClick={() => setRummyDealerIndex(idx)}
                        >
                          <span className="truncate">🃏 {name || `P${idx + 1}`}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="preview-card">
                    <div className="section-head" style={{ marginBottom: 6 }}>
                      <h2 className="section-title">Rummy 240 Pool Rules</h2>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-700)' }}>
                      • <strong>Knockout Target:</strong> 240 Points. Reaching or crossing 240 eliminates the player.<br />
                      • <strong>Winner of Deal:</strong> 0 penalty points (Show).<br />
                      • <strong>First Drop:</strong> 20 points · <strong>Middle Drop:</strong> 40 points · <strong>Full Count:</strong> 80 points.<br />
                      • <strong>Victory:</strong> Last surviving player wins the pool match!
                    </div>
                  </div>
                </>
              )}

              <button className="btn-primary-lg" onClick={handleStartGame}>
                Start {selectedGameType === 'trump' ? 'Trump Scorer' : 'Rummy 240 Match'} →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
         2. ACTIVE PLAY SCREEN — TRUMP (JUDGEMENT)
         ========================================================================= */}
      {screen === 'play' && activeGame && activeGame.game_type === 'trump' && currentTrumpMeta && (
        <>
          <div className="tab-bar">
            <div className="tab-bar-inner">
              <button
                className={`tab-btn ${viewTab === 'play' ? 'active' : ''}`}
                onClick={() => setViewTab('play')}
              >
                🎴 Play Round
              </button>
              <button
                className={`tab-btn ${viewTab === 'sheet' ? 'active' : ''}`}
                onClick={() => setViewTab('sheet')}
              >
                📓 Score Sheet ({trumpRounds.length}/19)
              </button>
            </div>
          </div>

          <main className="workspace">
            <section className={`pane-play ${viewTab === 'play' ? '' : 'mobile-hidden'}`}>
              {/* Stepper Strip */}
              <div className="progress-strip" style={{ marginBottom: 10 }}>
                {ROUND_CARDS.map((cnt, idx) => {
                  let cls = '';
                  if (idx === trumpRounds.length) cls = 'current';
                  else if (idx < trumpRounds.length) cls = idx >= 10 ? 'done-2' : 'done-1';
                  return (
                    <div key={idx} className={`prog-step ${cls} tabular`}>
                      {cnt}
                    </div>
                  );
                })}
              </div>

              {/* Role Strip */}
              <div className="role-strip">
                <div className="role-box server">
                  <span className="role-icon">🃏</span>
                  <div className="role-meta">
                    <div className="role-kicker">Serving</div>
                    <div className="role-name truncate">{activeGame.players[currentTrumpMeta.serverIdx].name}</div>
                  </div>
                </div>
                <div className="role-box first">
                  <span className="role-icon">▶</span>
                  <div className="role-meta">
                    <div className="role-kicker">1st Player</div>
                    <div className="role-name truncate">{activeGame.players[currentTrumpMeta.starterIdx].name}</div>
                  </div>
                </div>
              </div>

              {/* Phase Stepper */}
              <div className="phase-stepper">
                <div className={`phase-step ${trumpPhase === 'bidding' ? 'active' : 'done'}`}>
                  {trumpPhase === 'bidding' ? '1. Bidding (Calls)' : '✓ 1. Bids Confirmed'}
                </div>
                <div className={`phase-step ${trumpPhase === 'scoring' ? 'active' : ''}`}>
                  2. Tricks Won
                </div>
              </div>

              {/* Turn Cards */}
              <div className="player-cards">
                {currentTrumpMeta.turnOrder.map((pIdx, pos) => {
                  const player = activeGame.players[pIdx];
                  const isFirst = pos === 0;
                  const isServer = pos === 4;
                  const isActive = trumpActivePlayerIdx === pIdx;
                  const bidVal = trumpBids[pIdx];
                  const wonVal = trumpWons[pIdx];
                  const circleCls = isFirst ? 'first' : isServer ? 'server' : isActive ? 'active-num' : '';

                  const nums = Array.from({ length: currentTrumpMeta.cards + 1 }, (_, n) => n);
                  const gridClass = currentTrumpMeta.cards <= 3 ? 'cols-4' : currentTrumpMeta.cards <= 4 ? 'cols-5' : '';

                  return (
                    <div key={player.id} className={`player-card ${isActive ? 'active' : ''}`}>
                      <button className="player-card-header" onClick={() => setTrumpActivePlayerIdx(pIdx)}>
                        <div className="player-left">
                          <div className={`turn-circle ${circleCls}`}>{pos + 1}</div>
                          <div className="player-info">
                            <div className="player-name-row">
                              <span className="player-name">{player.name}</span>
                              {isFirst && <span className="badge-role badge-first">▶ 1st</span>}
                              {isServer && <span className="badge-role badge-server">🃏 Serving</span>}
                            </div>
                          </div>
                        </div>

                        <div className="player-right">
                          {trumpPhase === 'bidding' ? (
                            <div className={`val-box tabular ${bidVal !== null ? 'filled-bid' : isActive ? 'empty-active' : 'empty'}`}>
                              {bidVal !== null ? bidVal : '—'}
                            </div>
                          ) : (
                            <>
                              {wonVal !== null && (
                                <span className={`preview-pill ${scoreEntry(bidVal ?? 0, wonVal).status}`}>
                                  {scoreEntry(bidVal ?? 0, wonVal).notation} ({formatSigned(scoreEntry(bidVal ?? 0, wonVal).delta)})
                                </span>
                              )}
                              <span className="bid-chip tabular">Bid: {bidVal}</span>
                              <div className={`val-box tabular ${wonVal !== null ? 'filled-won' : isActive ? 'empty-active' : 'empty'}`}>
                                {wonVal !== null ? wonVal : '—'}
                              </div>
                            </>
                          )}
                        </div>
                      </button>

                      {isActive && (
                        <div className="tap-drawer">
                          <div className="tap-drawer-head">
                            <span className="tap-prompt">
                              {trumpPhase === 'bidding'
                                ? `Tap Bid for ${player.name} (0–${currentTrumpMeta.cards})`
                                : `Tap Tricks Won (${player.name})`}
                            </span>
                          </div>

                          <div className={`num-grid ${gridClass}`}>
                            {nums.map((n) => {
                              if (trumpPhase === 'bidding') {
                                return (
                                  <button
                                    key={n}
                                    className={`num-btn tabular ${bidVal === n ? 'selected-bid' : ''}`}
                                    onClick={() => {
                                      const next = [...trumpBids];
                                      next[pIdx] = n;
                                      setTrumpBids(next);
                                    }}
                                  >
                                    {n}
                                  </button>
                                );
                              } else {
                                return (
                                  <button
                                    key={n}
                                    className={`num-btn tabular ${wonVal === n ? 'selected-won' : ''}`}
                                    onClick={() => {
                                      const next = [...trumpWons];
                                      next[pIdx] = n;
                                      setTrumpWons(next);
                                    }}
                                  >
                                    {n}
                                  </button>
                                );
                              }
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Action Footer */}
              <div className="sticky-footer">
                <div className="sticky-footer-inner">
                  {trumpPhase === 'bidding' ? (
                    <>
                      <div className="footer-status tabular">Total Calls: {totalTrumpBids} / {currentTrumpMeta.cards}</div>
                      <button
                        className="btn-confirm-footer"
                        disabled={!allTrumpBidsDone}
                        onClick={() => {
                          setTrumpPhase('scoring');
                          setTrumpActivePlayerIdx(currentTrumpMeta.starterIdx);
                        }}
                      >
                        {allTrumpBidsDone ? 'Lock Calls & Score Tricks →' : 'Tap Bids for All 5'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn-secondary-md" onClick={() => setTrumpPhase('bidding')}>
                        ← Bids
                      </button>
                      <div className={`footer-status tabular ${totalTrumpWons === currentTrumpMeta.cards ? 'ok' : 'warn'}`}>
                        Tricks: {totalTrumpWons} / {currentTrumpMeta.cards}
                      </div>
                      <button
                        className="btn-confirm-footer"
                        disabled={!allTrumpWonsDone || totalTrumpWons !== currentTrumpMeta.cards}
                        onClick={confirmTrumpRound}
                      >
                        Save Round →
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>

            {/* Trump Notebook Sheet */}
            <aside className={`pane-sheet ${viewTab === 'sheet' ? '' : 'mobile-hidden'}`}>
              <div className="notebook-shell">
                <div className="notebook-topbar">
                  <span className="notebook-title">📓 Trump Score Sheet</span>
                  <span>{trumpRounds.length}/19</span>
                </div>
                <div className="notebook-scroll">
                  <table className="notebook-table">
                    <thead>
                      <tr>
                        {activeGame.players.map((p) => (
                          <th key={p.id}>{p.name}</th>
                        ))}
                        <th className="col-cards">Cards</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ROUND_CARDS.map((cards, rIdx) => {
                        const completed = trumpRounds[rIdx];
                        const isCurrent = rIdx === trumpRounds.length;
                        return (
                          <tr
                            key={rIdx}
                            className={completed ? 'sheet-row-done' : isCurrent ? 'sheet-row-current' : ''}
                          >
                            {activeGame.players.map((_, pIdx) => {
                              if (!completed) return <td key={pIdx} className="sheet-cell cell-empty">•</td>;
                              const e = scoreEntry(completed.bids[pIdx], completed.won[pIdx]);
                              return (
                                <td key={pIdx} className={`sheet-cell ${e.hit ? 'cell-hit' : 'cell-miss'} tabular`}>
                                  {e.notation}
                                </td>
                              );
                            })}
                            <td className="col-cards tabular">{cards}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </aside>
          </main>
        </>
      )}

      {/* =========================================================================
         2B. ACTIVE PLAY SCREEN — RUMMY 240 POINTS
         ========================================================================= */}
      {screen === 'play' && activeGame && activeGame.game_type === 'rummy240' && (
        <>
          <div className="tab-bar">
            <div className="tab-bar-inner">
              <button
                className={`tab-btn ${viewTab === 'play' ? 'active' : ''}`}
                onClick={() => setViewTab('play')}
              >
                🎴 Deal #{rummyRounds.length + 1}
              </button>
              <button
                className={`tab-btn ${viewTab === 'sheet' ? 'active' : ''}`}
                onClick={() => setViewTab('sheet')}
              >
                📓 Score Sheet ({rummyRounds.length} Deals)
              </button>
            </div>
          </div>

          <main className="workspace">
            <section className={`pane-play ${viewTab === 'play' ? '' : 'mobile-hidden'}`}>
              {/* Standings Bar */}
              <div className="standings-mini" style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 4 }}>
                {activeGame.players.map((p, idx) => {
                  const s = rummyStatuses[idx];
                  return (
                    <div key={p.id} className={`mini-card ${s?.isEliminated ? 'elim-row' : ''}`} style={{ flex: '1 0 72px' }}>
                      <div className="mini-name truncate">{p.name}</div>
                      <div className="mini-score tabular" style={{ color: s?.isEliminated ? 'var(--rose-600)' : 'var(--felt-900)' }}>
                        {s?.cumulativeScore ?? 0}
                      </div>
                      {s?.isEliminated && <div className="elim-badge">OUT</div>}
                    </div>
                  );
                })}
              </div>

              {/* Rummy Player Cards */}
              <div className="player-cards" style={{ marginTop: 10 }}>
                {activeGame.players.map((p, idx) => {
                  const status = rummyStatuses[idx];
                  const currentPenalty = rummyScores[idx];
                  const currentType = rummyTypes[idx];
                  const isEliminated = status?.isEliminated;

                  return (
                    <div key={p.id} className={`player-card ${isEliminated ? 'elim-row' : ''}`}>
                      <div className="player-card-header">
                        <div className="player-left">
                          <div className="turn-circle">{idx + 1}</div>
                          <div className="player-info">
                            <div className="player-name-row">
                              <span className="player-name">{p.name}</span>
                              {isEliminated && <span className="elim-badge">OUT (240+)</span>}
                            </div>
                            <div className="player-subline">
                              <span>Total: <strong>{status?.cumulativeScore ?? 0} pts</strong></span>
                              {currentPenalty !== null && !isEliminated && (
                                <span style={{ color: currentPenalty === 0 ? 'var(--felt-700)' : 'var(--rose-600)' }}>
                                  → Deal: +{currentPenalty} (New: {(status?.cumulativeScore ?? 0) + currentPenalty})
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {!isEliminated && (
                          <div className="player-right">
                            <div className={`val-box tabular ${currentPenalty === 0 ? 'filled-bid' : currentPenalty !== null ? 'filled-won' : 'empty'}`}>
                              {currentPenalty !== null ? `+${currentPenalty}` : '—'}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Quick Rummy 240 scoring buttons */}
                      {!isEliminated && (
                        <div className="tap-drawer" style={{ paddingTop: 6 }}>
                          <div className="rummy-btn-row">
                            <button
                              className={`rummy-quick-btn btn-show ${currentType === 'show' ? 'selected' : ''}`}
                              onClick={() => setRummyScoreQuick(idx, 0, 'show')}
                            >
                              <span>🏆 Show</span>
                              <span style={{ fontSize: 10 }}>0 pts</span>
                            </button>
                            <button
                              className={`rummy-quick-btn btn-drop ${currentType === 'drop' ? 'selected' : ''}`}
                              onClick={() => setRummyScoreQuick(idx, RUMMY_FIRST_DROP, 'drop')}
                            >
                              <span>🚪 1st Drop</span>
                              <span style={{ fontSize: 10 }}>20 pts</span>
                            </button>
                            <button
                              className={`rummy-quick-btn btn-mid ${currentType === 'middle' ? 'selected' : ''}`}
                              onClick={() => setRummyScoreQuick(idx, RUMMY_MIDDLE_DROP, 'middle')}
                            >
                              <span>🏃 Mid Drop</span>
                              <span style={{ fontSize: 10 }}>40 pts</span>
                            </button>
                            <button
                              className={`rummy-quick-btn btn-full ${currentType === 'full' ? 'selected' : ''}`}
                              onClick={() => setRummyScoreQuick(idx, RUMMY_FULL_COUNT, 'full')}
                            >
                              <span>💥 Full Count</span>
                              <span style={{ fontSize: 10 }}>80 pts</span>
                            </button>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-500)' }}>Manual Count:</span>
                            <input
                              type="number"
                              min={0}
                              max={80}
                              className="seat-input"
                              style={{ maxWidth: 80, padding: '4px 8px', background: '#fff', border: '1px solid var(--border-soft)', borderRadius: 8, textAlign: 'center' }}
                              placeholder="0..80"
                              value={currentType === 'manual' && currentPenalty !== null ? currentPenalty : ''}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10);
                                if (!isNaN(val) && val >= 0 && val <= 80) {
                                  setRummyScoreQuick(idx, val, 'manual');
                                }
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="sticky-footer">
                <div className="sticky-footer-inner">
                  <button className="btn-secondary-md" onClick={undoRummyDeal} disabled={rummyRounds.length === 0}>
                    ↩ Undo Deal
                  </button>
                  <button className="btn-confirm-footer" onClick={confirmRummyDeal}>
                    Save Deal #{rummyRounds.length + 1} →
                  </button>
                </div>
              </div>
            </section>

            {/* Rummy Score Sheet */}
            <aside className={`pane-sheet ${viewTab === 'sheet' ? '' : 'mobile-hidden'}`}>
              <div className="notebook-shell">
                <div className="notebook-topbar">
                  <span className="notebook-title">📓 Rummy 240 Score Sheet</span>
                  <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>Target: 240 Pts</span>
                </div>
                <div className="notebook-scroll">
                  <table className="notebook-table">
                    <thead>
                      <tr>
                        {activeGame.players.map((p) => (
                          <th key={p.id}>{p.name}</th>
                        ))}
                        <th className="col-cards">Deal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rummyRounds.length === 0 ? (
                        <tr>
                          <td colSpan={activeGame.players.length + 1} style={{ padding: 20, color: '#94a3b8' }}>
                            No deals completed yet. Tap 0 for show, 20/40 for drop, 80 for full count.
                          </td>
                        </tr>
                      ) : (
                        rummyRounds.map((rd, rIdx) => {
                          const cumTotals = computeRummyTotals(activeGame.players, rummyRounds, rIdx + 1);
                          return (
                            <tr key={rIdx} className="sheet-row-done">
                              {activeGame.players.map((_, pIdx) => {
                                const sc = rd.scores[pIdx];
                                const cum = cumTotals[pIdx];
                                const isOut = cum >= RUMMY_MAX_POINTS;
                                return (
                                  <td key={pIdx} className="sheet-cell tabular" style={{ color: isOut ? 'var(--rose-600)' : sc === 0 ? 'var(--felt-700)' : 'var(--ink-900)' }}>
                                    <div style={{ fontSize: 13, fontWeight: 800 }}>+{sc}</div>
                                    <div style={{ fontSize: 10, color: 'var(--ink-500)' }}>({cum})</div>
                                  </td>
                                );
                              })}
                              <td className="col-cards tabular">D{rIdx + 1}</td>
                            </tr>
                          );
                        })
                      )}
                      {/* Running Total row */}
                      {rummyRounds.length > 0 && (
                        <tr className="row-final">
                          {activeGame.players.map((_, pIdx) => {
                            const isOut = rummyTotals[pIdx] >= RUMMY_MAX_POINTS;
                            return (
                              <td key={pIdx} className="tabular" style={{ color: isOut ? 'var(--rose-600)' : 'var(--felt-800)' }}>
                                {rummyTotals[pIdx]} {isOut ? '❌' : ''}
                              </td>
                            );
                          })}
                          <td className="col-cards">TOT</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </aside>
          </main>
        </>
      )}

      {/* =========================================================================
         3. GAME OVER PODIUM (TRUMP & RUMMY 240)
         ========================================================================= */}
      {screen === 'gameover' && activeGame && (
        <div className="podium-hero">
          <div className="podium-trophy">🏆</div>
          <div className="podium-kicker">
            {activeGame.game_type === 'trump' ? '19 Rounds Complete' : 'Last Man Standing · Pool 240'}
          </div>
          <h1 className="podium-winner">
            {activeGame.winner_names.join(' & ') || 'Champion'} Wins!
          </h1>

          <div className="podium-body" style={{ marginTop: 20 }}>
            <div className="card-box">
              <div className="section-head" style={{ marginBottom: 8 }}>
                <h2 className="section-title">Final Standings</h2>
              </div>
              <div className="rank-list">
                {activeGame.game_type === 'trump'
                  ? rankPlayers(activeGame.players, computeTotals(activeGame.rounds as RoundRecord[]), activeGame.rounds as RoundRecord[]).map((p) => (
                      <div key={p.name} className={`rank-row ${p.rank === 1 ? 'first' : ''}`}>
                        <div className="rank-left">
                          <div className="rank-badge">{p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : `#${p.rank}`}</div>
                          <span className="player-name">{p.name}</span>
                        </div>
                        <div className="tabular" style={{ fontSize: 18, fontWeight: 900 }}>
                          {formatSigned(p.score)}
                        </div>
                      </div>
                    ))
                  : activeGame.players.map((p, idx) => {
                      const score = rummyTotals[idx];
                      const isWinner = activeGame.winner_names.includes(p.name);
                      return (
                        <div key={p.name} className={`rank-row ${isWinner ? 'first' : ''}`}>
                          <div className="rank-left">
                            <div className="rank-badge">{isWinner ? '🥇' : '❌'}</div>
                            <span className="player-name">{p.name}</span>
                          </div>
                          <div className="tabular" style={{ fontSize: 18, fontWeight: 900, color: score >= 240 ? 'var(--rose-600)' : 'var(--felt-700)' }}>
                            {score} pts {score >= 240 ? '(Eliminated)' : '(Survivor)'}
                          </div>
                        </div>
                      );
                    })}
              </div>
            </div>

            <div className="action-grid" style={{ marginTop: 14 }}>
              <button
                className="btn-action-card emerald"
                onClick={() => {
                  setScreen('setup');
                }}
              >
                🔄 Play New Game
              </button>
              <button
                className="btn-action-card"
                onClick={() => setScreen('history')}
              >
                📜 View Past Games
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
         4. HISTORY SCREEN
         ========================================================================= */}
      {screen === 'history' && (
        <div className="setup-bg">
          <div className="setup-wrap">
            <div className="brand-header">
              <h1 className="brand-title">Game History</h1>
              <p className="brand-sub">Saved matches across Trump & Rummy 240</p>
            </div>

            <div className="game-tab-strip">
              <button
                className={`game-tab-btn ${historyFilter === 'all' ? 'active' : ''}`}
                onClick={() => setHistoryFilter('all')}
              >
                All Games
              </button>
              <button
                className={`game-tab-btn ${historyFilter === 'trump' ? 'active' : ''}`}
                onClick={() => setHistoryFilter('trump')}
              >
                🃏 Trump ({games.filter((g) => g.game_type === 'trump').length})
              </button>
              <button
                className={`game-tab-btn ${historyFilter === 'rummy240' ? 'active' : ''}`}
                onClick={() => setHistoryFilter('rummy240')}
              >
                🎴 Rummy ({games.filter((g) => g.game_type === 'rummy240').length})
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {games
                .filter((g) => historyFilter === 'all' || g.game_type === historyFilter)
                .map((g) => (
                  <div key={g.id} className="card-box" style={{ background: '#fff' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <strong>{g.game_type === 'trump' ? '🃏 Trump (Judgement)' : '🎴 Indian Rummy 240'} #{g.id}</strong>
                        <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>
                          {g.players.map((p) => p.name).join(', ')} ·{' '}
                          {g.status === 'completed'
                            ? `Winner: ${g.winner_names.join(', ')}`
                            : `${g.rounds.length} rounds`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-ok" style={{ padding: '6px 12px', minHeight: 36, fontSize: 12 }} onClick={() => resumeGame(g)}>
                          {g.status === 'completed' ? 'View Sheet' : 'Resume'}
                        </button>
                        <button className="btn-danger" style={{ padding: '6px 10px', minHeight: 36, fontSize: 12 }} onClick={() => handleDeleteGame(g.id)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
            </div>

            <button className="btn-ghost-light" style={{ marginTop: 16 }} onClick={() => setScreen('setup')}>
              ← Back to New Game Setup
            </button>
          </div>
        </div>
      )}

      {/* =========================================================================
         SETTINGS MODAL
         ========================================================================= */}
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal-panel" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">⚙ Game Options</h3>
              <button className="modal-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                className="btn-action-card"
                onClick={() => {
                  setShowSettings(false);
                  setScreen('setup');
                }}
              >
                🏠 Back to Setup / Switch Game
              </button>
              <button
                className="btn-action-card"
                onClick={() => {
                  setShowSettings(false);
                  setScreen('history');
                }}
              >
                📜 View All Past Games
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-root">
          <div className={`toast-pill ${toast.tone}`}>{toast.msg}</div>
        </div>
      )}
    </div>
  );
}
