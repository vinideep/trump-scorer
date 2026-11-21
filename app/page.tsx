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

interface RosterPlayer {
  id: number;
  name: string;
  gamesPlayed: number;
  wins: number;
}

type ScreenMode = 'setup' | 'play' | 'gameover';
type ViewTab = 'play' | 'sheet';
type RoundPhase = 'bidding' | 'scoring';

export default function TrumpScorerPage() {
  const [screen, setScreen] = useState<ScreenMode>('setup');
  const [viewTab, setViewTab] = useState<ViewTab>('play');
  const [gameOverShowSheet, setGameOverShowSheet] = useState(false);

  // Database state
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [toast, setToast] = useState<{ msg: string; tone: 'dark' | 'success' | 'error' } | null>(null);

  // Setup state
  const [seats, setSeats] = useState<string[]>(['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5']);
  const [starterIndex, setStarterIndex] = useState<number>(0);
  const [initialDirection, setInitialDirection] = useState<Direction>('CW');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [manageRoster, setManageRoster] = useState(false);

  // Active game state
  const [activeGame, setActiveGame] = useState<GameRecord | null>(null);
  const [phase, setPhase] = useState<RoundPhase>('bidding');
  const [activePlayerIdx, setActivePlayerIdx] = useState<number>(0);
  const [currentBids, setCurrentBids] = useState<(number | null)[]>([null, null, null, null, null]);
  const [currentWons, setCurrentWons] = useState<(number | null)[]>([null, null, null, null, null]);

  // Modals
  const [showSchedule, setShowSchedule] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingRoundIdx, setEditingRoundIdx] = useState<number | null>(null);
  const [editTab, setEditTab] = useState<'bids' | 'wons'>('wons');
  const [editActivePlayer, setEditActivePlayer] = useState<number>(0);
  const [editBids, setEditBids] = useState<number[]>([0, 0, 0, 0, 0]);
  const [editWons, setEditWons] = useState<number[]>([0, 0, 0, 0, 0]);

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
      showToast('Could not reach database. Check TURSO_DATABASE_URL.', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // --- Roster interactions ---
  const toggleRosterPlayer = (p: RosterPlayer) => {
    const existingIdx = seats.indexOf(p.name);
    if (existingIdx !== -1) {
      const next = [...seats];
      next[existingIdx] = `Player ${existingIdx + 1}`;
      setSeats(next);
      return;
    }
    const emptyIdx = seats.findIndex((name, idx) => name === `Player ${idx + 1}` || name.trim() === '');
    if (emptyIdx === -1) {
      showToast('All 5 seats have names. Tap a seat to replace someone.', 'dark');
      return;
    }
    const next = [...seats];
    next[emptyIdx] = p.name;
    setSeats(next);
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

      const emptyIdx = seats.findIndex((name, idx) => name === `Player ${idx + 1}` || name.trim() === '');
      if (emptyIdx !== -1) {
        const next = [...seats];
        next[emptyIdx] = data.player.name;
        setSeats(next);
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
      setSeats((prev) => prev.map((s) => (s === p.name ? 'Player' : s)));
      setSyncState('saved');
      showToast(`Removed "${p.name}"`, 'dark');
    } catch {
      setSyncState('error');
      showToast('Failed to delete player', 'error');
    }
  };

  const moveSeat = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target > 4) return;
    const next = [...seats];
    [next[idx], next[target]] = [next[target], next[idx]];
    setSeats(next);
    if (starterIndex === idx) setStarterIndex(target);
    else if (starterIndex === target) setStarterIndex(idx);
  };

  // --- Start & Resume Game ---
  const handleStartGame = async () => {
    const players: PlayerRef[] = seats.map((name, i) => {
      const found = roster.find((r) => r.name.toLowerCase() === name.toLowerCase());
      return { id: found ? found.id : i + 1, name: name.trim() || `Player ${i + 1}` };
    });

    setSyncState('saving');
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          players,
          first_player_idx: starterIndex,
          initial_dir: initialDirection,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setActiveGame(data.game);
      setGames((prev) => [data.game, ...prev]);
      const meta = getRoundMeta(0, starterIndex, initialDirection);
      setPhase('bidding');
      setActivePlayerIdx(meta.starterIdx);
      setCurrentBids([null, null, null, null, null]);
      setCurrentWons([null, null, null, null, null]);
      setScreen('play');
      setViewTab('play');
      setSyncState('saved');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setSyncState('error');
      showToast('Failed to start game in database', 'error');
    }
  };

  const resumeGame = (g: GameRecord) => {
    setActiveGame(g);
    setSeats(g.players.map((p) => p.name));
    setStarterIndex(g.first_player_idx);
    setInitialDirection(g.initial_dir);

    if (g.rounds.length >= 19) {
      setScreen('gameover');
    } else {
      const meta = getRoundMeta(g.rounds.length, g.first_player_idx, g.initial_dir);
      setPhase('bidding');
      setActivePlayerIdx(meta.starterIdx);
      setCurrentBids([null, null, null, null, null]);
      setCurrentWons([null, null, null, null, null]);
      setScreen('play');
      setViewTab('play');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const persistRounds = async (g: GameRecord, nextRounds: RoundRecord[]) => {
    const optimistic: GameRecord = {
      ...g,
      rounds: nextRounds,
      status: nextRounds.length >= 19 ? 'completed' : 'active',
      winner_names: getWinners(g.players, nextRounds),
    };
    setActiveGame(optimistic);
    setGames((prev) => prev.map((item) => (item.id === g.id ? optimistic : item)));
    setSyncState('saving');

    try {
      const res = await fetch(`/api/games/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rounds: nextRounds }),
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

  // --- Active Round Navigation & Controls ---
  const currentRoundIdx = activeGame ? activeGame.rounds.length : 0;
  const isCompleted = currentRoundIdx >= 19;
  const currentMeta = useMemo(() => {
    if (!activeGame || isCompleted) return null;
    return getRoundMeta(currentRoundIdx, activeGame.first_player_idx, activeGame.initial_dir);
  }, [activeGame, currentRoundIdx, isCompleted]);

  const totalBids = currentBids.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const allBidsDone = currentBids.every((v) => v !== null);
  const totalWons = currentWons.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const allWonsDone = currentWons.every((v) => v !== null);

  const findNextUnfilled = (turnOrder: number[], currentIdx: number, arr: (number | null)[]) => {
    const pos = turnOrder.indexOf(currentIdx);
    for (let step = 1; step <= 5; step++) {
      const cand = turnOrder[(pos + step) % 5];
      if (arr[cand] === null) return cand;
    }
    return currentIdx;
  };

  const tapBid = (pIdx: number, val: number) => {
    if (!currentMeta) return;
    const next = [...currentBids];
    next[pIdx] = val;
    setCurrentBids(next);
    const nextPlayer = findNextUnfilled(currentMeta.turnOrder, pIdx, next);
    setActivePlayerIdx(nextPlayer);
  };

  const lockBidsAndPlay = () => {
    if (!allBidsDone || !currentMeta) return;
    setPhase('scoring');
    setActivePlayerIdx(currentMeta.starterIdx);
    showToast('Bids confirmed! Tap tricks won.', 'success');
  };

  const tapWon = (pIdx: number, val: number) => {
    if (!currentMeta) return;
    const next = [...currentWons];
    next[pIdx] = val;
    setCurrentWons(next);
    const nextPlayer = findNextUnfilled(currentMeta.turnOrder, pIdx, next);
    setActivePlayerIdx(nextPlayer);
  };

  const setRestToZero = () => {
    const next = currentWons.map((v) => (v === null ? 0 : v));
    setCurrentWons(next);
    showToast('Set remaining players to 0', 'success');
  };

  const confirmRound = async () => {
    if (!activeGame || !currentMeta) return;
    if (!allBidsDone || !allWonsDone || totalWons !== currentMeta.cards) {
      showToast(`Total tricks won is ${totalWons}, must equal ${currentMeta.cards}.`, 'error');
      return;
    }

    const newRecord: RoundRecord = {
      roundNumber: currentMeta.roundNumber,
      cards: currentMeta.cards,
      bids: currentBids as number[],
      won: currentWons as number[],
    };

    const nextRounds = [...activeGame.rounds, newRecord];
    await persistRounds(activeGame, nextRounds);

    if (nextRounds.length >= 19) {
      setScreen('gameover');
      showToast('All 19 rounds complete! 🏆', 'success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const nextMeta = getRoundMeta(nextRounds.length, activeGame.first_player_idx, activeGame.initial_dir);
      setPhase('bidding');
      setActivePlayerIdx(nextMeta.starterIdx);
      setCurrentBids([null, null, null, null, null]);
      setCurrentWons([null, null, null, null, null]);
      if (nextRounds.length === 10) {
        showToast(`🔄 Rotation reversed! Now ${nextMeta.activeDir === 'CW' ? '↻ Clockwise' : '↺ Anti-Clockwise'}.`, 'success');
      } else {
        showToast(`Round ${currentMeta.roundNumber} saved!`, 'success');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const undoLastRound = async () => {
    if (!activeGame || activeGame.rounds.length === 0) return;
    const lastRoundNum = activeGame.rounds.length;
    const popped = activeGame.rounds[activeGame.rounds.length - 1];
    const nextRounds = activeGame.rounds.slice(0, -1);

    await persistRounds(activeGame, nextRounds);
    const meta = getRoundMeta(nextRounds.length, activeGame.first_player_idx, activeGame.initial_dir);

    setScreen('play');
    setViewTab('play');
    setPhase('scoring');
    setActivePlayerIdx(meta.starterIdx);
    setCurrentBids([...popped.bids]);
    setCurrentWons([...popped.won]);
    showToast(`Reopened Round ${lastRoundNum}`);
  };

  // --- Inline Round Editor ---
  const openEditRound = (rIdx: number) => {
    if (!activeGame) return;
    const r = activeGame.rounds[rIdx];
    const meta = getRoundMeta(rIdx, activeGame.first_player_idx, activeGame.initial_dir);
    setEditingRoundIdx(rIdx);
    setEditTab('wons');
    setEditActivePlayer(meta.starterIdx);
    setEditBids([...r.bids]);
    setEditWons([...r.won]);
  };

  const saveEditedRound = async () => {
    if (!activeGame || editingRoundIdx === null) return;
    const cards = ROUND_CARDS[editingRoundIdx];
    const sumW = editWons.reduce((a, b) => a + b, 0);
    if (sumW !== cards) {
      showToast(`Total tricks won must equal ${cards} (currently ${sumW})`, 'error');
      return;
    }

    const nextRounds = activeGame.rounds.map((r, idx) =>
      idx === editingRoundIdx ? { ...r, bids: [...editBids], won: [...editWons] } : r
    );

    const rNum = editingRoundIdx + 1;
    setEditingRoundIdx(null);
    await persistRounds(activeGame, nextRounds);
    showToast(`Round ${rNum} updated & all subtotals recalculated!`, 'success');
  };

  // --- WhatsApp Summary Copy ---
  const copySummary = () => {
    if (!activeGame) return;
    const totals = computeTotals(activeGame.rounds);
    const ranked = rankPlayers(activeGame.players, totals, activeGame.rounds);
    const medals: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉', 4: '4.', 5: '5.' };
    const count = activeGame.rounds.length;

    const lines = [
      `♠️♥️ TRUMP CARD GAME — ${count === 19 ? 'FINAL RESULTS' : `AFTER ROUND ${count}/19`} ♦️♣️`,
      `Rotation: ${activeGame.initial_dir === 'CW' ? '↻ CW → ↺ ACW' : '↺ ACW → ↻ CW'}`,
      '',
    ];

    ranked.forEach((p) => {
      lines.push(`${medals[p.rank] || p.rank + '.'} ${p.name}: ${formatSigned(p.score)} pts (${p.exactHits}/${count} exact)`);
    });

    const hl = computeHighlights(activeGame.players, activeGame.rounds);
    if (hl && count > 0) {
      lines.push('');
      lines.push('✨ Match Highlights:');
      lines.push(`• Most Exact Calls: ${hl.mostExact.names} (${hl.mostExact.count}/${count})`);
      lines.push(`• Biggest Round: ${hl.bestRound.player} (${hl.bestRound.notation}, R${hl.bestRound.roundNum})`);
      lines.push(`• Best Jump: ${hl.bestJump.player} (${formatSigned(hl.bestJump.gain)} in ${hl.bestJump.label})`);
      lines.push(`• Cleanest Streak: ${hl.cleanestStreak.names} (${hl.cleanestStreak.streak} in a row)`);
    }

    navigator.clipboard?.writeText(lines.join('\n'));
    showToast('WhatsApp summary copied!', 'success');
  };

  // Previews for setup
  const r1Preview = getRoundMeta(0, starterIndex, initialDirection);
  const r11Preview = getRoundMeta(10, starterIndex, initialDirection);
  const activeSavedGame = games.find((g) => g.status === 'active');
  const runningTotals = activeGame ? computeTotals(activeGame.rounds) : [0, 0, 0, 0, 0];
  const maxRunningScore = Math.max(...runningTotals);

  return (
    <div className="app-shell">
      {/* =========================================================================
         1. SETUP SCREEN
         ========================================================================= */}
      {screen === 'setup' && (
        <div className="setup-bg">
          <div className="setup-wrap">
            <div className="brand-header">
              <div className="brand-badge">♠ ♥ ♦ ♣ Tabletop Scorer</div>
              <h1 className="brand-title">Trump Scorer</h1>
              <p className="brand-sub">5 Players · 19 Rounds (10 → 1 → 10)</p>
            </div>

            {/* Resume Banner */}
            {activeSavedGame && (
              <div className="resume-banner">
                <div className="resume-banner-text">
                  <div className="resume-banner-title">Saved Game In Progress</div>
                  <div className="resume-banner-sub">
                    Round {activeSavedGame.rounds.length + 1} / 19 · {activeSavedGame.players.map((p) => p.name).join(', ')}
                  </div>
                </div>
                <button className="btn-resume" onClick={() => resumeGame(activeSavedGame)}>
                  Resume R{activeSavedGame.rounds.length + 1} →
                </button>
              </div>
            )}

            <div className="setup-card">
              {/* Seating Order */}
              <div>
                <div className="section-head">
                  <h2 className="section-title">Players (Starting Play Order)</h2>
                  <button
                    className="section-hint"
                    onClick={() => setManageRoster((v) => !v)}
                  >
                    {manageRoster ? 'Done' : 'Manage Roster'}
                  </button>
                </div>
                <p className="helper-copy">
                  List players in your starting play order (Player 5 serves to Player 1 in Round 1).
                </p>

                <div className="seat-list">
                  {seats.map((name, idx) => (
                    <div key={idx} className="seat-row">
                      <div className="seat-num">{idx + 1}</div>
                      <input
                        type="text"
                        className="seat-input"
                        maxLength={18}
                        value={name}
                        placeholder={`Player ${idx + 1}`}
                        onChange={(e) => {
                          const next = [...seats];
                          next[idx] = e.target.value;
                          setSeats(next);
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
                          disabled={idx === 4}
                          onClick={() => moveSeat(idx, 1)}
                          title="Move Down"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Saved Player Roster Chips */}
                {roster.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink-500)', textTransform: 'uppercase' }}>
                      Tap Saved Player to Fill Empty Seat ({roster.length}):
                    </div>
                    <div className="roster-grid">
                      {roster.map((player) => {
                        const seatIdx = seats.indexOf(player.name);
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
                    placeholder="+ Add friend to permanent database roster…"
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                    maxLength={32}
                  />
                  <button className="btn-icon-sm" style={{ width: 'auto', padding: '0 12px', fontSize: 13 }} type="submit" disabled={!newPlayerName.trim()}>
                    Add
                  </button>
                </form>
              </div>

              {/* Starter Selection */}
              <div>
                <div className="section-head">
                  <h2 className="section-title">Who Goes 1st in Round 1?</h2>
                </div>
                <div className="pill-grid-5">
                  {seats.map((name, idx) => (
                    <button
                      key={idx}
                      className={`starter-pill ${starterIndex === idx ? 'active' : ''}`}
                      onClick={() => setStarterIndex(idx)}
                    >
                      <span className="truncate">{name || `P${idx + 1}`}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Initial Rotation Direction */}
              <div>
                <div className="section-head">
                  <h2 className="section-title">Initial Rotation Direction</h2>
                </div>
                <div className="segmented-2">
                  <button
                    className={`seg-btn ${initialDirection === 'CW' ? 'active-cw' : ''}`}
                    onClick={() => setInitialDirection('CW')}
                  >
                    <span>↻ Clockwise</span>
                    <span className="seg-sub">Flips to ↺ ACW after R10</span>
                  </button>
                  <button
                    className={`seg-btn ${initialDirection === 'ACW' ? 'active-acw' : ''}`}
                    onClick={() => setInitialDirection('ACW')}
                  >
                    <span>↺ Anti-Clockwise</span>
                    <span className="seg-sub">Flips to ↻ CW after R10</span>
                  </button>
                </div>
              </div>

              {/* Live Preview Card */}
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
                    <div className="preview-role-name truncate">{seats[r1Preview.serverIdx] || `P${r1Preview.serverIdx + 1}`}</div>
                  </div>
                  <div className="preview-role first">
                    <div className="preview-role-label">▶ 1st Player</div>
                    <div className="preview-role-name truncate">{seats[r1Preview.starterIdx] || `P${r1Preview.starterIdx + 1}`}</div>
                  </div>
                </div>
                <div className="order-chain">
                  {r1Preview.turnOrder.map((p) => seats[p] || `P${p + 1}`).join(' → ')}
                </div>
                <div className="reversal-note">
                  🔄 Rotation reverses after Round 10 (1 card) → Round 11 ({r11Preview.activeDir === 'CW' ? '↻ CW' : '↺ ACW'}): 🃏 {seats[r11Preview.serverIdx] || `P${r11Preview.serverIdx + 1}`} serves to ▶ {seats[r11Preview.starterIdx] || `P${r11Preview.starterIdx + 1}`}
                </div>
              </div>

              {/* Start Button */}
              <button className="btn-primary-lg" onClick={handleStartGame}>
                Start Game →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
         2. ACTIVE PLAY SCREEN
         ========================================================================= */}
      {screen === 'play' && activeGame && currentMeta && (
        <>
          <header className="topbar">
            <div className="topbar-inner">
              <div className="topbar-row">
                <div className="topbar-badges">
                  <span className="pill-round tabular">Round {currentMeta.roundNumber} / 19</span>
                  <span className="pill-cards tabular">🃏 {currentMeta.cards} {currentMeta.cards === 1 ? 'Card' : 'Cards'}</span>
                  <span className={`pill-dir ${currentMeta.activeDir === 'CW' ? 'cw' : 'acw'}`}>
                    {currentMeta.activeDir === 'CW' ? '↻ CW' : '↺ ACW'}
                  </span>
                </div>
                <div className="topbar-actions">
                  <button
                    className="top-icon-btn"
                    disabled={activeGame.rounds.length === 0}
                    onClick={undoLastRound}
                    title="Undo Last Round"
                  >
                    ↩
                  </button>
                  <button className="top-icon-btn" onClick={() => setShowSchedule(true)} title="Schedule">
                    📅
                  </button>
                  <button className="top-icon-btn" onClick={() => setShowSettings(true)} title="Settings">
                    ⚙
                  </button>
                </div>
              </div>

              {/* 19-Round Progress Strip */}
              <div className="progress-strip">
                {ROUND_CARDS.map((cnt, idx) => {
                  let cls = '';
                  if (idx === currentRoundIdx) cls = 'current';
                  else if (idx < activeGame.rounds.length) cls = idx >= 10 ? 'done-2' : 'done-1';
                  return (
                    <div key={idx} className={`prog-step ${cls} tabular`} title={`R${idx + 1}: ${cnt} cards`}>
                      {cnt}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Mobile Tab Bar */}
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
                  📓 Score Sheet ({activeGame.rounds.length}/19)
                </button>
              </div>
            </div>
          </header>

          <main className="workspace">
            {/* Play Round Pane */}
            <section className={`pane-play ${viewTab === 'play' ? '' : 'mobile-hidden'}`}>
              {/* Rotation Reversal Banners */}
              {currentMeta.roundIdx === 10 && (
                <div className="reversal-banner-big">
                  <span>🔄 Rotation Reversed! Now playing {currentMeta.activeDir === 'CW' ? '↻ Clockwise' : '↺ Anti-Clockwise'}</span>
                  <span>R11</span>
                </div>
              )}
              {currentMeta.roundIdx > 10 && (
                <div className="reversal-banner-subtle">
                  🔄 Reversed Rotation Active · {currentMeta.activeDir === 'CW' ? '↻ Clockwise' : '↺ Anti-Clockwise'}
                </div>
              )}

              {/* Role Strip: Serving & 1st Player */}
              <div className="role-strip">
                <div className="role-box server">
                  <span className="role-icon">🃏</span>
                  <div className="role-meta">
                    <div className="role-kicker">Serving</div>
                    <div className="role-name truncate">{activeGame.players[currentMeta.serverIdx].name}</div>
                  </div>
                </div>
                <div className="role-box first">
                  <span className="role-icon">▶</span>
                  <div className="role-meta">
                    <div className="role-kicker">1st Player</div>
                    <div className="role-name truncate">{activeGame.players[currentMeta.starterIdx].name}</div>
                  </div>
                </div>
              </div>

              {/* Live Mini-Standings Bar */}
              <div className="standings-mini">
                {activeGame.players.map((p, idx) => {
                  const sc = runningTotals[idx];
                  const isLeader = activeGame.rounds.length > 0 && sc === maxRunningScore;
                  const cls = sc > 0 ? 'score-pos' : sc < 0 ? 'score-neg' : 'score-zero';
                  return (
                    <div key={p.id} className={`mini-card ${isLeader ? 'leader' : ''}`}>
                      <div className="mini-name">
                        {isLeader ? '👑 ' : ''}
                        <span className="truncate">{p.name}</span>
                      </div>
                      <div className={`mini-score tabular ${cls}`}>{formatSigned(sc)}</div>
                    </div>
                  );
                })}
              </div>

              {/* Phase Stepper */}
              <div className="phase-stepper">
                <div className={`phase-step ${phase === 'bidding' ? 'active' : 'done'}`}>
                  {phase === 'bidding' ? '1. Bidding (Calls)' : '✓ 1. Bids Confirmed'}
                </div>
                <div className={`phase-step ${phase === 'scoring' ? 'active' : ''}`}>
                  2. Tricks Won
                </div>
              </div>

              {/* 5 Turn Cards in Play Order */}
              <div className="player-cards">
                {currentMeta.turnOrder.map((pIdx, pos) => {
                  const player = activeGame.players[pIdx];
                  const isFirst = pos === 0;
                  const isServer = pos === 4;
                  const isActive = activePlayerIdx === pIdx;
                  const bidVal = currentBids[pIdx];
                  const wonVal = currentWons[pIdx];
                  const circleCls = isFirst ? 'first' : isServer ? 'server' : isActive ? 'active-num' : '';

                  const nums = Array.from({ length: currentMeta.cards + 1 }, (_, n) => n);
                  const gridClass = currentMeta.cards <= 3 ? 'cols-4' : currentMeta.cards <= 4 ? 'cols-5' : '';

                  return (
                    <div key={player.id} className={`player-card ${isActive ? 'active' : ''}`}>
                      <button className="player-card-header" onClick={() => setActivePlayerIdx(pIdx)}>
                        <div className="player-left">
                          <div className={`turn-circle ${circleCls}`}>{pos + 1}</div>
                          <div className="player-info">
                            <div className="player-name-row">
                              <span className="player-name">{player.name}</span>
                              {isFirst && <span className="badge-role badge-first">▶ 1st</span>}
                              {isServer && <span className="badge-role badge-server">🃏 Serving</span>}
                            </div>
                            <div className="player-subline tabular">
                              {phase === 'bidding' ? (
                                <span>Running Total: <strong>{formatSigned(runningTotals[pIdx])}</strong></span>
                              ) : wonVal !== null ? (
                                <span>
                                  New Total: <strong>{formatSigned(runningTotals[pIdx] + scoreEntry(bidVal ?? 0, wonVal).delta)}</strong>
                                </span>
                              ) : (
                                <span>Current: {formatSigned(runningTotals[pIdx])}</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="player-right">
                          {phase === 'bidding' ? (
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

                      {/* Tap Drawer for Active Player */}
                      {isActive && (
                        <div className="tap-drawer">
                          <div className="tap-drawer-head">
                            <span className="tap-prompt">
                              {phase === 'bidding'
                                ? `Tap Bid for ${player.name} (0–${currentMeta.cards})`
                                : `Tap Tricks Won (${player.name})`}
                            </span>
                            {phase === 'scoring' && currentWons.some((v) => v === null) && totalWons <= currentMeta.cards && (
                              <button className="btn-rest-zero" onClick={setRestToZero}>
                                Set rest to 0
                              </button>
                            )}
                          </div>

                          <div className={`num-grid ${gridClass}`}>
                            {nums.map((n) => {
                              if (phase === 'bidding') {
                                return (
                                  <button
                                    key={n}
                                    className={`num-btn tabular ${bidVal === n ? 'selected-bid' : ''}`}
                                    onClick={() => tapBid(pIdx, n)}
                                  >
                                    {n}
                                  </button>
                                );
                              } else {
                                const otherSum = currentWons.reduce<number>((s, v, idx) => s + (idx === pIdx ? 0 : (v ?? 0)), 0);
                                const otherEmpty = currentWons.filter((v, idx) => idx !== pIdx && v === null).length;
                                const remainingForPlayer = currentMeta.cards - otherSum;
                                const isExact = otherEmpty === 0 && remainingForPlayer === n && wonVal !== n;
                                const disabled = n > remainingForPlayer && wonVal !== n;

                                return (
                                  <button
                                    key={n}
                                    disabled={disabled}
                                    className={`num-btn tabular ${wonVal === n ? 'selected-won' : ''} ${isExact ? 'exact-hint' : ''}`}
                                    onClick={() => tapWon(pIdx, n)}
                                  >
                                    <span>{n}</span>
                                    {isExact && <span className="exact-tag">Exact</span>}
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

              {/* Sticky Bottom Action Footer */}
              <div className="sticky-footer">
                <div className="sticky-footer-inner">
                  {phase === 'bidding' ? (
                    <>
                      <div className="footer-status tabular">Total Bids: {totalBids} / {currentMeta.cards}</div>
                      <button
                        className="btn-confirm-footer"
                        disabled={!allBidsDone}
                        onClick={lockBidsAndPlay}
                      >
                        {allBidsDone ? 'Confirm Bids & Start Round →' : 'Tap Bids for All 5'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn-secondary-md" onClick={() => setPhase('bidding')}>
                        ← Edit Bids
                      </button>
                      <div className={`footer-status tabular ${totalWons === currentMeta.cards && allWonsDone ? 'ok' : totalWons > currentMeta.cards ? 'warn' : ''}`}>
                        Tricks: {totalWons} / {currentMeta.cards} {totalWons === currentMeta.cards && allWonsDone ? '✓' : ''}
                      </div>
                      <button
                        className="btn-confirm-footer"
                        disabled={!allWonsDone || totalWons !== currentMeta.cards}
                        onClick={confirmRound}
                      >
                        {currentMeta.roundNumber === 19 ? 'Save Final Round 🏆' : 'Save Round →'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>

            {/* Score Sheet Pane */}
            <aside className={`pane-sheet ${viewTab === 'sheet' ? '' : 'mobile-hidden'}`}>
              <div className="notebook-shell">
                <div className="notebook-topbar">
                  <span className="notebook-title">📓 Score Sheet ({activeGame.rounds.length}/19)</span>
                  <div className="notebook-legend">
                    <span className="cell-hit">+Hit</span>
                    <span className="cell-zero">0+0</span>
                    <span className="cell-miss">-Miss</span>
                    <span style={{ color: 'var(--ink-500)' }}>▶ 1st · 🃏 Srv</span>
                  </div>
                </div>

                <div className="notebook-scroll">
                  <table className="notebook-table">
                    <thead>
                      <tr>
                        {activeGame.players.map((p) => (
                          <th key={p.id} className="truncate" title={p.name}>{p.name}</th>
                        ))}
                        <th className="col-cards">Cards</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ROUND_CARDS.map((cards, rIdx) => {
                        const completed = activeGame.rounds[rIdx];
                        const isCurrent = rIdx === currentRoundIdx;
                        const rMeta = getRoundMeta(rIdx, activeGame.first_player_idx, activeGame.initial_dir);

                        const cells = activeGame.players.map((_, pIdx) => {
                          const marker = pIdx === rMeta.starterIdx ? '▶' : pIdx === rMeta.serverIdx ? '🃏' : '';
                          if (!completed) {
                            return (
                              <td key={pIdx} className="sheet-cell cell-empty">
                                {marker && <span className="cell-marker">{marker}</span>}
                                {isCurrent ? '•' : ''}
                              </td>
                            );
                          }
                          const e = scoreEntry(completed.bids[pIdx], completed.won[pIdx]);
                          const cls = e.status === 'hit' ? 'cell-hit' : e.status === 'zero' ? 'cell-zero' : 'cell-miss';
                          return (
                            <td key={pIdx} className={`sheet-cell ${cls} tabular`}>
                              {marker && <span className="cell-marker">{marker}</span>}
                              {e.notation}
                            </td>
                          );
                        });

                        const showSubtotal = SUBTOTAL_CHECKPOINTS[rIdx];
                        const reached = activeGame.rounds.length > rIdx;
                        const subtotalScores = reached ? computeTotals(activeGame.rounds, rIdx + 1) : null;
                        const isFinal = rIdx === 18;

                        return (
                          <React.Fragment key={rIdx}>
                            {rIdx === 10 && (
                              <tr className="row-reversal">
                                <td colSpan={6}>
                                  🔄 ROTATION REVERSED ({activeGame.initial_dir === 'CW' ? '↻ CW → ↺ ACW' : '↺ ACW → ↻ CW'})
                                </td>
                              </tr>
                            )}
                            <tr
                              className={`${completed ? 'sheet-row-done' : isCurrent ? 'sheet-row-current' : ''}`}
                              onClick={() => completed && openEditRound(rIdx)}
                              title={completed ? `Tap to edit Round ${rIdx + 1}` : ''}
                            >
                              {cells}
                              <td className="col-cards tabular">
                                {cards}
                                <span className="col-cards-sub">R{rIdx + 1}</span>
                              </td>
                            </tr>
                            {showSubtotal && (
                              <tr className={isFinal ? 'row-final' : 'row-subtotal'}>
                                {activeGame.players.map((_, pIdx) => {
                                  if (!subtotalScores) return <td key={pIdx} style={{ color: '#94a3b8' }}>—</td>;
                                  const val = subtotalScores[pIdx];
                                  const cls = val > 0 ? 'score-pos' : val < 0 ? 'score-neg' : 'score-zero';
                                  return (
                                    <td key={pIdx} className={`tabular ${cls}`}>
                                      {formatSigned(val)}
                                    </td>
                                  );
                                })}
                                <td className="col-cards">{isFinal ? 'TOT' : 'SUB'}</td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="sheet-tip">
                  💡 Tap any completed round row to edit bids or tricks — all subtotals recalculate instantly.
                </div>
              </div>
            </aside>
          </main>
        </>
      )}

      {/* =========================================================================
         3. GAME OVER PODIUM & HIGHLIGHTS
         ========================================================================= */}
      {screen === 'gameover' && activeGame && (
        <>
          {(() => {
            const totals = computeTotals(activeGame.rounds);
            const ranked = rankPlayers(activeGame.players, totals, activeGame.rounds);
            const winners = ranked.filter((p) => p.rank === 1);
            const winnerTitle = winners.map((w) => w.name).join(' & ');
            const hl = computeHighlights(activeGame.players, activeGame.rounds);

            return (
              <>
                <div className="podium-hero">
                  <div className="podium-trophy">🏆</div>
                  <div className="podium-kicker">
                    19 Rounds Complete · {activeGame.initial_dir === 'CW' ? '↻ CW → ↺ ACW' : '↺ ACW → ↻ CW'}
                  </div>
                  <h1 className="podium-winner">{winnerTitle} {winners.length > 1 ? 'Tie!' : 'Wins!'}</h1>
                  <p className="podium-score tabular">Winning Score: {formatSigned(winners[0].score)} points</p>
                </div>

                <div className="podium-body">
                  <div className="card-box">
                    <div className="section-head" style={{ marginBottom: 0 }}>
                      <h2 className="section-title">Final Standings</h2>
                      <button className="btn-icon-sm" style={{ width: 'auto', padding: '0 10px', fontSize: 12 }} onClick={() => setShowSchedule(true)}>
                        📅 Schedule
                      </button>
                    </div>

                    <div className="rank-list">
                      {ranked.map((p) => (
                        <div key={p.name} className={`rank-row ${p.rank === 1 ? 'first' : ''}`}>
                          <div className="rank-left">
                            <div className="rank-badge">{p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : `#${p.rank}`}</div>
                            <div style={{ minWidth: 0 }}>
                              <div className="player-name truncate">{p.name}</div>
                              <div style={{ fontSize: 12, color: 'var(--ink-500)' }}>
                                {p.exactHits}/19 exact calls · {p.misses} misses
                              </div>
                            </div>
                          </div>
                          <div className={`tabular ${p.score > 0 ? 'score-pos' : p.score < 0 ? 'score-neg' : 'score-zero'}`} style={{ fontSize: 21, fontWeight: 900 }}>
                            {formatSigned(p.score)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Highlights Grid */}
                  {hl && (
                    <div className="card-box">
                      <div className="section-head" style={{ marginBottom: 0 }}>
                        <h2 className="section-title">Match Highlights</h2>
                      </div>
                      <div className="highlights-grid">
                        <div className="stat-tile">
                          <div className="stat-label">🎯 Most Exact Calls</div>
                          <div className="stat-value truncate">{hl.mostExact.names}</div>
                          <div className="stat-detail">{hl.mostExact.count} / 19 exact bids hit</div>
                        </div>
                        <div className="stat-tile">
                          <div className="stat-label">🔥 Biggest Single Round</div>
                          <div className="stat-value truncate">{hl.bestRound.player}</div>
                          <div className="stat-detail">{hl.bestRound.notation} ({formatSigned(hl.bestRound.delta)}) in Round {hl.bestRound.roundNum}</div>
                        </div>
                        <div className="stat-tile">
                          <div className="stat-label">🚀 Best Subtotal Jump</div>
                          <div className="stat-value truncate">{hl.bestJump.player}</div>
                          <div className="stat-detail">{formatSigned(hl.bestJump.gain)} pts in {hl.bestJump.label}</div>
                        </div>
                        <div className="stat-tile">
                          <div className="stat-label">✨ Cleanest Streak</div>
                          <div className="stat-value truncate">{hl.cleanestStreak.names}</div>
                          <div className="stat-detail">{hl.cleanestStreak.streak} in a row · {hl.cleanestStreak.fewestMissesGlobal} min misses</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="action-grid">
                    <button className="btn-action-card emerald" onClick={copySummary}>
                      📋 Copy WhatsApp Summary
                    </button>
                    <button className="btn-action-card" onClick={() => setGameOverShowSheet((v) => !v)}>
                      {gameOverShowSheet ? 'Hide Score Sheet ▲' : '📓 View Score Sheet ▼'}
                    </button>
                    <button className="btn-action-card" onClick={undoLastRound}>
                      ↩ Undo Round 19
                    </button>
                    <button
                      className="btn-action-card emerald"
                      onClick={() => {
                        setSeats(activeGame.players.map((p) => p.name));
                        setScreen('setup');
                      }}
                    >
                      🔄 Play Again
                    </button>
                  </div>

                  {/* Toggleable Score Sheet */}
                  {gameOverShowSheet && (
                    <div className="notebook-shell" style={{ marginTop: 12 }}>
                      <div className="notebook-topbar">
                        <span className="notebook-title">📓 Final 19-Round Score Sheet</span>
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
                            {activeGame.rounds.map((r, rIdx) => (
                              <tr key={rIdx} className="sheet-row-done" onClick={() => openEditRound(rIdx)}>
                                {r.bids.map((b, pIdx) => {
                                  const res = scoreEntry(b, r.won[pIdx]);
                                  const cls = res.status === 'hit' ? 'cell-hit' : res.status === 'zero' ? 'cell-zero' : 'cell-miss';
                                  return (
                                    <td key={pIdx} className={`sheet-cell ${cls} tabular`}>
                                      {res.notation}
                                    </td>
                                  );
                                })}
                                <td className="col-cards tabular">{r.cards}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </>
      )}

      {/* =========================================================================
         SCHEDULE MODAL
         ========================================================================= */}
      {showSchedule && activeGame && (
        <div className="modal-backdrop" onClick={() => setShowSchedule(false)}>
          <div className="modal-panel" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">📅 Full 19-Round Rotation Schedule</h3>
              <button className="modal-close" onClick={() => setShowSchedule(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="sched-table">
                <thead>
                  <tr>
                    <th>Rd</th>
                    <th>Cards</th>
                    <th>Dir</th>
                    <th>🃏 Serving</th>
                    <th>▶ 1st Player</th>
                    <th>Turn Order</th>
                  </tr>
                </thead>
                <tbody>
                  {ROUND_CARDS.map((cards, r) => {
                    const m = getRoundMeta(r, activeGame.first_player_idx, activeGame.initial_dir);
                    const isCurrent = r === activeGame.rounds.length;
                    return (
                      <React.Fragment key={r}>
                        {r === 10 && (
                          <tr className="row-reversal">
                            <td colSpan={6} style={{ textAlign: 'center' }}>
                              🔄 ROTATION REVERSED AFTER 1-CARD ROUND
                            </td>
                          </tr>
                        )}
                        <tr className={isCurrent ? 'sched-current' : ''}>
                          <td className="tabular"><strong>R{r + 1}</strong>{isCurrent ? ' ●' : ''}</td>
                          <td className="tabular">{cards}</td>
                          <td>{m.activeDir === 'CW' ? '↻ CW' : '↺ ACW'}</td>
                          <td>🃏 {activeGame.players[m.serverIdx].name}</td>
                          <td>▶ {activeGame.players[m.starterIdx].name}</td>
                          <td style={{ fontSize: 10.5, color: 'var(--ink-500)' }}>
                            {m.turnOrder.map((p) => activeGame.players[p].name).join(' → ')}
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="modal-footer">
              <button className="btn-ok" onClick={() => setShowSchedule(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
         SETTINGS / OPTIONS MODAL
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
                🏠 Back to Setup (Keep Game Saved)
              </button>
              <button
                className="btn-action-card"
                onClick={() => {
                  setShowSettings(false);
                  setShowSchedule(true);
                }}
              >
                📅 View 19-Round Schedule
              </button>
              <button
                className="btn-action-card"
                onClick={() => {
                  setShowSettings(false);
                  copySummary();
                }}
              >
                📋 Copy Standings for WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
         EDIT ROUND MODAL
         ========================================================================= */}
      {editingRoundIdx !== null && activeGame && (() => {
        const meta = getRoundMeta(editingRoundIdx, activeGame.first_player_idx, activeGame.initial_dir);
        const cardCount = ROUND_CARDS[editingRoundIdx];
        const sumWon = editWons.reduce((a, b) => a + b, 0);
        const isValid = sumWon === cardCount;
        const nums = Array.from({ length: cardCount + 1 }, (_, i) => i);
        const gridClass = cardCount <= 3 ? 'cols-4' : cardCount <= 4 ? 'cols-5' : '';

        return (
          <div className="modal-backdrop" onClick={() => setEditingRoundIdx(null)}>
            <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h3 className="modal-title">Edit Round {editingRoundIdx + 1} ({cardCount} {cardCount === 1 ? 'Card' : 'Cards'})</h3>
                  <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 2 }}>
                    {meta.activeDir === 'CW' ? '↻ CW' : '↺ ACW'} · 🃏 Serving: {activeGame.players[meta.serverIdx].name}
                  </div>
                </div>
                <button className="modal-close" onClick={() => setEditingRoundIdx(null)}>✕</button>
              </div>

              <div className="modal-body">
                <div className="segmented-2" style={{ marginBottom: 12 }}>
                  <button className={`seg-btn ${editTab === 'bids' ? 'active-cw' : ''}`} onClick={() => setEditTab('bids')}>
                    Edit Bids
                  </button>
                  <button className={`seg-btn ${editTab === 'wons' ? 'active-cw' : ''}`} onClick={() => setEditTab('wons')}>
                    Edit Tricks Won
                  </button>
                </div>

                {meta.turnOrder.map((pIdx) => {
                  const player = activeGame.players[pIdx];
                  const isActive = editActivePlayer === pIdx;
                  const sc = scoreEntry(editBids[pIdx], editWons[pIdx]);
                  const otherSum = editWons.reduce((s, v, idx) => s + (idx === pIdx ? 0 : v), 0);
                  const maxAllowedWon = Math.max(0, cardCount - otherSum);

                  return (
                    <div key={player.id} className={`player-card ${isActive ? 'active' : ''}`} style={{ marginBottom: 8 }}>
                      <button className="player-card-header" onClick={() => setEditActivePlayer(pIdx)}>
                        <div className="player-left">
                          <span className="player-name">{player.name}</span>
                          {pIdx === meta.starterIdx && <span className="badge-role badge-first">1st</span>}
                          {pIdx === meta.serverIdx && <span className="badge-role badge-server">🃏</span>}
                        </div>
                        <div className="player-right">
                          <span className={`preview-pill ${sc.status}`}>{sc.notation} ({formatSigned(sc.delta)})</span>
                          <span className="bid-chip tabular">B:{editBids[pIdx]}</span>
                          <span className="bid-chip tabular" style={{ background: '#0f172a', color: '#fff', borderColor: '#0f172a' }}>
                            W:{editWons[pIdx]}
                          </span>
                        </div>
                      </button>

                      {isActive && (
                        <div className="tap-drawer">
                          <div className="tap-drawer-head">
                            <span className="tap-prompt">
                              {editTab === 'bids' ? `Tap Bid (${player.name})` : `Tap Tricks Won (${player.name})`}
                            </span>
                          </div>
                          <div className={`num-grid ${gridClass}`}>
                            {nums.map((n) => {
                              const isSel = editTab === 'bids' ? editBids[pIdx] === n : editWons[pIdx] === n;
                              const disabled = editTab === 'wons' && n > maxAllowedWon && !isSel;
                              return (
                                <button
                                  key={n}
                                  disabled={disabled}
                                  className={`num-btn tabular ${isSel ? (editTab === 'bids' ? 'selected-bid' : 'selected-won') : ''}`}
                                  onClick={() => {
                                    if (editTab === 'bids') {
                                      const next = [...editBids];
                                      next[pIdx] = n;
                                      setEditBids(next);
                                    } else {
                                      const next = [...editWons];
                                      next[pIdx] = n;
                                      setEditWons(next);
                                    }
                                  }}
                                >
                                  {n}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
                <div className={`footer-status tabular ${isValid ? 'ok' : 'warn'}`}>
                  Tricks: {sumWon} / {cardCount} {isValid ? '✓' : ''}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-secondary-md" style={{ minHeight: 44 }} onClick={() => setEditingRoundIdx(null)}>
                    Cancel
                  </button>
                  <button className="btn-ok" disabled={!isValid} onClick={saveEditedRound}>
                    Save Round {editingRoundIdx + 1}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Toast */}
      {toast && (
        <div className="toast-root">
          <div className={`toast-pill ${toast.tone}`}>{toast.msg}</div>
        </div>
      )}
    </div>
  );
}
