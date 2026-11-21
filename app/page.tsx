'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  computeTotals,
  formatSigned,
  getRoundMeta,
  getWinners,
  ROUND_CARDS,
  scoreEntry,
  SUBTOTAL_AFTER_ROUNDS,
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

type ViewMode = 'setup' | 'play' | 'history';
type RoundPhase = 'bid' | 'won';

export default function TrumpScorerPage() {
  const [view, setView] = useState<ViewMode>('setup');
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [toast, setToast] = useState<string | null>(null);

  // Setup state
  const [seats, setSeats] = useState<(PlayerRef | null)[]>([null, null, null, null, null]);
  const [firstPlayerIdx, setFirstPlayerIdx] = useState<number>(0);
  const [initialDir, setInitialDir] = useState<Direction>('CW');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [manageRoster, setManageRoster] = useState(false);

  // Active game state
  const [activeGame, setActiveGame] = useState<GameRecord | null>(null);
  const [phase, setPhase] = useState<RoundPhase>('bid');
  const [draftBids, setDraftBids] = useState<(number | null)[]>([null, null, null, null, null]);
  const [draftWon, setDraftWon] = useState<(number | null)[]>([null, null, null, null, null]);
  const [focusedTurnPos, setFocusedTurnPos] = useState<number>(0);

  // Modals
  const [showSchedule, setShowSchedule] = useState(false);
  const [editingRoundIdx, setEditingRoundIdx] = useState<number | null>(null);
  const [editBids, setEditBids] = useState<number[]>([0, 0, 0, 0, 0]);
  const [editWon, setEditWon] = useState<number[]>([0, 0, 0, 0, 0]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((curr) => (curr === msg ? null : curr)), 2600);
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
      showToast('Could not reach database. Check TURSO_DATABASE_URL.');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // --- Roster Management & 1-Tap Selection ---

  const toggleRosterPlayer = (player: RosterPlayer) => {
    const existingSeat = seats.findIndex((s) => s?.id === player.id);
    if (existingSeat !== -1) {
      const next = [...seats];
      next[existingSeat] = null;
      setSeats(next);
      return;
    }
    const emptyIdx = seats.findIndex((s) => s === null);
    if (emptyIdx === -1) {
      showToast('All 5 seats are filled. Tap a seat to remove someone first.');
      return;
    }
    const next = [...seats];
    next[emptyIdx] = { id: player.id, name: player.name };
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
        showToast(data.error || 'Could not add player');
        setSyncState('error');
        return;
      }
      const created: RosterPlayer = data.player;
      setRoster((prev) =>
        [...prev, created].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      );
      setNewPlayerName('');
      setSyncState('saved');

      // Auto-assign to first open seat if available
      const emptyIdx = seats.findIndex((s) => s === null);
      if (emptyIdx !== -1) {
        const next = [...seats];
        next[emptyIdx] = { id: created.id, name: created.name };
        setSeats(next);
      }
      showToast(`Added "${created.name}" to roster`);
    } catch {
      setSyncState('error');
      showToast('Network error adding player');
    }
  };

  const handleDeletePlayer = async (player: RosterPlayer) => {
    setSyncState('saving');
    try {
      const res = await fetch(`/api/players/${player.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      setRoster((prev) => prev.filter((p) => p.id !== player.id));
      setSeats((prev) => prev.map((s) => (s?.id === player.id ? null : s)));
      setSyncState('saved');
      showToast(`Removed "${player.name}"`);
    } catch {
      setSyncState('error');
      showToast('Failed to delete player');
    }
  };

  const swapSeats = (idxA: number, idxB: number) => {
    if (idxB < 0 || idxB > 4) return;
    const next = [...seats];
    [next[idxA], next[idxB]] = [next[idxB], next[idxA]];
    setSeats(next);
  };

  const allFiveSeated = seats.every((s) => s !== null);

  // --- Start / Resume / Sync Games ---

  const resetRoundDrafts = () => {
    setPhase('bid');
    setDraftBids([null, null, null, null, null]);
    setDraftWon([null, null, null, null, null]);
    setFocusedTurnPos(0);
  };

  const handleStartGame = async () => {
    if (!allFiveSeated) return;
    setSyncState('saving');
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          players: seats as PlayerRef[],
          first_player_idx: firstPlayerIdx,
          initial_dir: initialDir,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setActiveGame(data.game);
      setGames((prev) => [data.game, ...prev]);
      resetRoundDrafts();
      setView('play');
      setSyncState('saved');
    } catch {
      setSyncState('error');
      showToast('Failed to create game in database');
    }
  };

  const persistRounds = async (game: GameRecord, nextRounds: RoundRecord[]) => {
    const optimistic: GameRecord = {
      ...game,
      rounds: nextRounds,
      status: nextRounds.length >= 19 ? 'completed' : 'active',
      winner_names: getWinners(game.players, nextRounds),
    };
    setActiveGame(optimistic);
    setGames((prev) => prev.map((g) => (g.id === game.id ? optimistic : g)));
    setSyncState('saving');

    try {
      const res = await fetch(`/api/games/${game.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rounds: nextRounds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error();
      setActiveGame(data.game);
      setGames((prev) => prev.map((g) => (g.id === game.id ? data.game : g)));
      setSyncState('saved');
      if (data.game.status === 'completed') {
        loadAllData(); // Refresh player win stats
      }
    } catch {
      setSyncState('error');
      showToast('Failed to save to database — check connection');
    }
  };

  const handleDeleteGame = async (gameId: number) => {
    try {
      await fetch(`/api/games/${gameId}`, { method: 'DELETE' });
      setGames((prev) => prev.filter((g) => g.id !== gameId));
      if (activeGame?.id === gameId) {
        setActiveGame(null);
        setView('setup');
      }
      showToast('Game deleted');
    } catch {
      showToast('Failed to delete game');
    }
  };

  const openGame = (game: GameRecord) => {
    setActiveGame(game);
    resetRoundDrafts();
    setView('play');
  };

  // --- Active Round Calculations ---

  const currentRoundIdx = activeGame ? activeGame.rounds.length : 0;
  const isCompleted = activeGame ? activeGame.rounds.length >= 19 : false;

  const currentMeta = useMemo(() => {
    if (!activeGame || isCompleted) return null;
    return getRoundMeta(currentRoundIdx, activeGame.first_player_idx, activeGame.initial_dir);
  }, [activeGame, currentRoundIdx, isCompleted]);

  const sumBids = draftBids.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const allBidsEntered = draftBids.every((v) => v !== null);
  const sumWon = draftWon.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const allWonEntered = draftWon.every((v) => v !== null);
  const remainingTricks = currentMeta ? currentMeta.cards - sumWon : 0;

  const handlePickBid = (seatIdx: number, turnPos: number, val: number) => {
    const next = [...draftBids];
    next[seatIdx] = val;
    setDraftBids(next);
    if (turnPos < 4) setFocusedTurnPos(turnPos + 1);
  };

  const handlePickWon = (seatIdx: number, turnPos: number, val: number) => {
    const next = [...draftWon];
    next[seatIdx] = val;
    setDraftWon(next);
    if (turnPos < 4) setFocusedTurnPos(turnPos + 1);
  };

  const handleSetRemainingToZero = () => {
    const next = draftWon.map((v) => (v === null ? 0 : v));
    setDraftWon(next);
  };

  const handleConfirmRound = async () => {
    if (!activeGame || !currentMeta) return;
    if (!allBidsEntered || !allWonEntered || sumWon !== currentMeta.cards) return;

    const record: RoundRecord = {
      roundNumber: currentMeta.roundNumber,
      cards: currentMeta.cards,
      bids: draftBids as number[],
      won: draftWon as number[],
    };
    resetRoundDrafts();
    await persistRounds(activeGame, [...activeGame.rounds, record]);
  };

  const handleUndoLastRound = async () => {
    if (!activeGame || activeGame.rounds.length === 0) return;
    const nextRounds = activeGame.rounds.slice(0, -1);
    resetRoundDrafts();
    await persistRounds(activeGame, nextRounds);
    showToast(`Undid Round ${activeGame.rounds.length}`);
  };

  // --- Inline Round Editor ---

  const openRoundEditor = (roundIdx: number) => {
    if (!activeGame) return;
    const r = activeGame.rounds[roundIdx];
    setEditingRoundIdx(roundIdx);
    setEditBids([...r.bids]);
    setEditWon([...r.won]);
  };

  const saveEditedRound = async () => {
    if (!activeGame || editingRoundIdx === null) return;
    const cards = ROUND_CARDS[editingRoundIdx];
    const totalWon = editWon.reduce((a, b) => a + b, 0);
    if (totalWon !== cards) {
      showToast(`Total tricks won must equal ${cards} (currently ${totalWon})`);
      return;
    }
    const nextRounds = activeGame.rounds.map((r, idx) =>
      idx === editingRoundIdx ? { ...r, bids: [...editBids], won: [...editWon] } : r
    );
    setEditingRoundIdx(null);
    await persistRounds(activeGame, nextRounds);
    showToast(`Updated Round ${editingRoundIdx + 1}`);
  };

  // --- WhatsApp Summary Copy ---

  const copySummary = () => {
    if (!activeGame) return;
    const totals = computeTotals(activeGame.rounds);
    const ranked = activeGame.players
      .map((p, idx) => ({ name: p.name, score: totals[idx] }))
      .sort((a, b) => b.score - a.score);

    const lines = [
      `🃏 *Trump Game Result (${activeGame.rounds.length}/19 Rounds)*`,
      ...ranked.map((r, i) => `${i === 0 ? '🏆' : `${i + 1}.`} ${r.name}: ${formatSigned(r.score)}`),
    ];
    navigator.clipboard?.writeText(lines.join('\n'));
    showToast('Summary copied for WhatsApp!');
  };

  // Setup preview meta
  const r1Preview = getRoundMeta(0, firstPlayerIdx, initialDir);
  const r11Preview = getRoundMeta(10, firstPlayerIdx, initialDir);
  const activeSavedGame = games.find((g) => g.status === 'active');

  return (
    <div className="app-shell">
      {/* Top Navigation */}
      <header className="topbar">
        <div className="brand">
          <span>🃏 Trump Scorer</span>
          {syncState === 'saving' && <span className="sync-pill saving">Saving…</span>}
          {syncState === 'saved' && <span className="sync-pill">Saved ✓</span>}
          {syncState === 'error' && <span className="sync-pill error">DB Error</span>}
        </div>
        <div className="nav-actions">
          <button
            className={`btn btn-sm ${view === 'setup' ? 'btn-blue' : ''}`}
            onClick={() => setView('setup')}
          >
            + New Game
          </button>
          {activeGame && (
            <button
              className={`btn btn-sm ${view === 'play' ? 'btn-blue' : ''}`}
              onClick={() => setView('play')}
            >
              Active ({activeGame.rounds.length}/19)
            </button>
          )}
          <button
            className={`btn btn-sm ${view === 'history' ? 'btn-blue' : ''}`}
            onClick={() => setView('history')}
          >
            History ({games.length})
          </button>
        </div>
      </header>

      {/* ==================== SETUP VIEW ==================== */}
      {view === 'setup' && (
        <>
          {activeSavedGame && activeSavedGame.id !== activeGame?.id && (
            <div className="card" style={{ borderColor: 'var(--amber)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <strong>Resume unfinished game?</strong>
                  <div className="muted">
                    {activeSavedGame.players.map((p) => p.name).join(', ')} • Round {activeSavedGame.rounds.length}/19
                  </div>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => openGame(activeSavedGame)}>
                  Resume Game →
                </button>
              </div>
            </div>
          )}

          {/* Step 1: Seats & Tap-to-Select Roster */}
          <section className="card">
            <div className="card-title">
              <span>1. Tap 5 Players in Seating Order</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => setSeats([null, null, null, null, null])}
                >
                  Clear Seats
                </button>
                <button
                  className={`btn btn-sm ${manageRoster ? 'btn-danger' : ''}`}
                  onClick={() => setManageRoster((v) => !v)}
                >
                  {manageRoster ? 'Done' : 'Manage Roster'}
                </button>
              </div>
            </div>

            {/* 5 Seat Slots */}
            <div className="seats-grid">
              {seats.map((seat, idx) => (
                <div key={idx} className={`seat-card ${seat ? 'filled' : ''}`}>
                  <div className="seat-header">
                    <span>Seat {idx + 1}</span>
                    {seat && (
                      <div className="seat-controls">
                        <button
                          className="icon-btn"
                          disabled={idx === 0}
                          onClick={() => swapSeats(idx, idx - 1)}
                          title="Move left"
                        >
                          ◀
                        </button>
                        <button
                          className="icon-btn"
                          disabled={idx === 4}
                          onClick={() => swapSeats(idx, idx + 1)}
                          title="Move right"
                        >
                          ▶
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => {
                            const next = [...seats];
                            next[idx] = null;
                            setSeats(next);
                          }}
                          title="Remove from seat"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="seat-name">
                    {seat ? seat.name : <span className="muted">Tap player below…</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* Saved Player Database Chips */}
            <div style={{ marginBottom: 6, fontSize: '0.82rem', fontWeight: 700, color: 'var(--muted)' }}>
              SAVED PLAYERS ({roster.length}) — TAP TO SELECT
            </div>

            {loading ? (
              <p className="muted">Loading players from database…</p>
            ) : roster.length === 0 ? (
              <p className="muted">No saved players yet. Add your regular players below once, then tap to select anytime.</p>
            ) : (
              <div className="roster-grid">
                {roster.map((player) => {
                  const seatIndex = seats.findIndex((s) => s?.id === player.id);
                  const isSelected = seatIndex !== -1;
                  return (
                    <div
                      key={player.id}
                      className={`roster-chip ${isSelected ? 'selected' : ''}`}
                      onClick={() => !manageRoster && toggleRosterPlayer(player)}
                      style={{ cursor: manageRoster ? 'default' : 'pointer' }}
                    >
                      {isSelected && <span className="chip-badge">#{seatIndex + 1}</span>}
                      <span>{player.name}</span>
                      {player.gamesPlayed > 0 && (
                        <span className="chip-meta">
                          {player.wins}W/{player.gamesPlayed}G
                        </span>
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
            )}

            {/* Add New Player to DB */}
            <form className="add-player-row" onSubmit={handleAddPlayer}>
              <input
                className="text-input"
                type="text"
                placeholder="Add new player name to database…"
                value={newPlayerName}
                onChange={(e) => setNewPlayerName(e.target.value)}
                maxLength={32}
              />
              <button className="btn btn-primary" type="submit" disabled={!newPlayerName.trim()}>
                + Add
              </button>
            </form>
          </section>

          {/* Step 2: Round 1 Starter & Initial Direction */}
          <section className="card">
            <div className="card-title">2. Round 1 Starter & Initial Direction</div>

            <div style={{ marginBottom: 12 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Who won the card draw to play 1st in Round 1?
              </div>
              <div className="pill-row">
                {seats.map((seat, idx) => (
                  <button
                    key={idx}
                    className={`pill-btn ${firstPlayerIdx === idx ? 'active' : ''}`}
                    onClick={() => setFirstPlayerIdx(idx)}
                  >
                    {seat ? seat.name : `Seat ${idx + 1}`}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Initial Table Direction (reverses automatically after Round 10)
              </div>
              <div className="pill-row">
                <button
                  className={`pill-btn ${initialDir === 'CW' ? 'active' : ''}`}
                  onClick={() => setInitialDir('CW')}
                >
                  ↻ Clockwise → Anti-Clockwise
                </button>
                <button
                  className={`pill-btn ${initialDir === 'ACW' ? 'active' : ''}`}
                  onClick={() => setInitialDir('ACW')}
                >
                  ↺ Anti-Clockwise → Clockwise
                </button>
              </div>
            </div>

            {/* Live Round 1 & Round 11 Preview */}
            <div className="preview-box" style={{ marginBottom: 14 }}>
              <div>
                <strong>Round 1 (10 cards • {r1Preview.activeDir === 'CW' ? '↻ CW' : '↺ ACW'}):</strong>{' '}
                🃏 Serving: <strong>{seats[r1Preview.serverIdx]?.name ?? `Seat ${r1Preview.serverIdx + 1}`}</strong>
                {' • '}▶ 1st: <strong>{seats[r1Preview.starterIdx]?.name ?? `Seat ${r1Preview.starterIdx + 1}`}</strong>
              </div>
              <div className="muted">
                Order: {r1Preview.turnOrder.map((i) => seats[i]?.name ?? `S${i + 1}`).join(' → ')}
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                <strong>Round 11 Reversal (2 cards • {r11Preview.activeDir === 'CW' ? '↻ CW' : '↺ ACW'}):</strong>{' '}
                🃏 Serving: <strong>{seats[r11Preview.serverIdx]?.name ?? `Seat ${r11Preview.serverIdx + 1}`}</strong>
                {' • '}▶ 1st: <strong>{seats[r11Preview.starterIdx]?.name ?? `Seat ${r11Preview.starterIdx + 1}`}</strong>
              </div>
            </div>

            <button
              className="btn btn-primary"
              style={{ width: '100%', padding: '13px', fontSize: '1rem' }}
              disabled={!allFiveSeated}
              onClick={handleStartGame}
            >
              {allFiveSeated ? 'Start 19-Round Game →' : `Select ${seats.filter((s) => !s).length} more player(s)`}
            </button>
          </section>
        </>
      )}

      {/* ==================== PLAY VIEW ==================== */}
      {view === 'play' && activeGame && (
        <div className="play-layout">
          {/* Left Column: Active Round Scorer OR Game Complete */}
          <div>
            {!isCompleted && currentMeta ? (
              <section className="card">
                <div className="card-title">
                  <span>
                    Round {currentMeta.roundNumber}/19 • {currentMeta.cards}{' '}
                    {currentMeta.cards === 1 ? 'Card' : 'Cards'}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => setShowSchedule(true)}>
                      📅 Schedule
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={activeGame.rounds.length === 0}
                      onClick={handleUndoLastRound}
                    >
                      ↩ Undo
                    </button>
                  </div>
                </div>

                {currentMeta.roundNumber === 11 && (
                  <div className="reversal-banner">
                    🔄 Rotation Reversed! Now playing{' '}
                    {currentMeta.activeDir === 'CW' ? '↻ Clockwise' : '↺ Anti-Clockwise'}.
                  </div>
                )}

                <div className="role-banner">
                  <span className="badge badge-amber">
                    🃏 Serving: {activeGame.players[currentMeta.serverIdx].name}
                  </span>
                  <span className="badge badge-green">
                    ▶ 1st: {activeGame.players[currentMeta.starterIdx].name}
                  </span>
                  <span className="badge badge-blue">
                    {currentMeta.activeDir === 'CW' ? '↻ CW' : '↺ ACW'}
                  </span>
                </div>

                {/* Phase Switcher */}
                <div className="pill-row" style={{ marginBottom: 12 }}>
                  <button
                    className={`pill-btn ${phase === 'bid' ? 'active' : ''}`}
                    style={{ flex: 1 }}
                    onClick={() => setPhase('bid')}
                  >
                    1. Calls / Bids {allBidsEntered ? `✓ (${sumBids})` : ''}
                  </button>
                  <button
                    className={`pill-btn ${phase === 'won' ? 'active' : ''}`}
                    style={{ flex: 1 }}
                    disabled={!allBidsEntered}
                    onClick={() => {
                      setPhase('won');
                      setFocusedTurnPos(0);
                    }}
                  >
                    2. Tricks Won ({sumWon}/{currentMeta.cards})
                  </button>
                </div>

                {/* Phase 1: Bidding */}
                {phase === 'bid' && (
                  <>
                    {currentMeta.turnOrder.map((seatIdx, turnPos) => {
                      const player = activeGame.players[seatIdx];
                      const val = draftBids[seatIdx];
                      return (
                        <div
                          key={seatIdx}
                          className={`turn-row ${focusedTurnPos === turnPos ? 'active-focus' : ''}`}
                          onClick={() => setFocusedTurnPos(turnPos)}
                        >
                          <div className="turn-row-head">
                            <div className="turn-name">
                              <span>{turnPos + 1}. {player.name}</span>
                              {seatIdx === currentMeta.starterIdx && (
                                <span className="badge badge-green">1st</span>
                              )}
                              {seatIdx === currentMeta.serverIdx && (
                                <span className="badge badge-amber">Serving</span>
                              )}
                            </div>
                            <span className="muted">
                              Call: <strong>{val === null ? '—' : val}</strong>
                            </span>
                          </div>
                          <div className="num-grid">
                            {Array.from({ length: currentMeta.cards + 1 }, (_, n) => (
                              <button
                                key={n}
                                className={`num-btn ${val === n ? 'selected' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handlePickBid(seatIdx, turnPos, n);
                                }}
                              >
                                {n}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    <button
                      className="btn btn-primary"
                      style={{ width: '100%', padding: '12px', marginTop: 4 }}
                      disabled={!allBidsEntered}
                      onClick={() => {
                        setPhase('won');
                        setFocusedTurnPos(0);
                      }}
                    >
                      Lock Calls (Total: {sumBids}) → Score Tricks Won
                    </button>
                  </>
                )}

                {/* Phase 2: Tricks Won */}
                {phase === 'won' && (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 10,
                        fontSize: '0.84rem',
                      }}
                    >
                      <span>
                        Remaining tricks to assign:{' '}
                        <strong
                          style={{
                            color: remainingTricks === 0 ? 'var(--accent)' : 'var(--amber)',
                          }}
                        >
                          {remainingTricks}
                        </strong>
                      </span>
                      {remainingTricks === 0 && !allWonEntered && (
                        <button className="btn btn-sm btn-primary" onClick={handleSetRemainingToZero}>
                          Set rest to 0
                        </button>
                      )}
                    </div>

                    {currentMeta.turnOrder.map((seatIdx, turnPos) => {
                      const player = activeGame.players[seatIdx];
                      const bid = draftBids[seatIdx] ?? 0;
                      const won = draftWon[seatIdx];
                      const otherWon = sumWon - (won ?? 0);
                      const maxAllowed = currentMeta.cards - otherWon;
                      const unfilledOthers = draftWon.filter(
                        (v, i) => i !== seatIdx && v === null
                      ).length;
                      const exactForLast = unfilledOthers === 0 ? maxAllowed : null;
                      const preview = won !== null ? scoreEntry(bid, won) : null;

                      return (
                        <div
                          key={seatIdx}
                          className={`turn-row ${focusedTurnPos === turnPos ? 'active-focus' : ''}`}
                          onClick={() => setFocusedTurnPos(turnPos)}
                        >
                          <div className="turn-row-head">
                            <div className="turn-name">
                              <span>{player.name}</span>
                              <span className="muted">(Called {bid})</span>
                            </div>
                            {preview ? (
                              <span
                                style={{
                                  fontWeight: 800,
                                  color: preview.hit ? '#6ee7b7' : '#fca5a5',
                                }}
                              >
                                {preview.notation} ({formatSigned(preview.delta)})
                              </span>
                            ) : (
                              <span className="muted">Tap tricks won</span>
                            )}
                          </div>
                          <div className="num-grid">
                            {Array.from({ length: currentMeta.cards + 1 }, (_, n) => {
                              const disabled = n > maxAllowed;
                              const isExactHint = exactForLast === n && won !== n;
                              return (
                                <button
                                  key={n}
                                  disabled={disabled}
                                  className={`num-btn ${won === n ? 'selected' : ''} ${
                                    isExactHint ? 'exact-hint' : ''
                                  }`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handlePickWon(seatIdx, turnPos, n);
                                  }}
                                >
                                  {n}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    <button
                      className="btn btn-primary"
                      style={{ width: '100%', padding: '13px', marginTop: 4 }}
                      disabled={!allWonEntered || sumWon !== currentMeta.cards}
                      onClick={handleConfirmRound}
                    >
                      {sumWon === currentMeta.cards && allWonEntered
                        ? `Save Round ${currentMeta.roundNumber} ✓`
                        : `Assign all ${currentMeta.cards} tricks (${sumWon}/${currentMeta.cards})`}
                    </button>
                  </>
                )}
              </section>
            ) : (
              /* Game Complete Podium */
              <section className="card">
                <div className="card-title">
                  <span>🏆 Match Complete!</span>
                  <button className="btn btn-sm btn-danger" onClick={handleUndoLastRound}>
                    ↩ Undo Round 19
                  </button>
                </div>

                {(() => {
                  const totals = computeTotals(activeGame.rounds);
                  const ranked = activeGame.players
                    .map((p, idx) => ({ name: p.name, score: totals[idx] }))
                    .sort((a, b) => b.score - a.score);
                  const topScore = ranked[0]?.score ?? 0;

                  return (
                    <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
                      {ranked.map((r, i) => (
                        <div
                          key={r.name}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '11px 14px',
                            borderRadius: 12,
                            background:
                              r.score === topScore
                                ? 'rgba(16, 185, 129, 0.16)'
                                : 'var(--bg)',
                            border:
                              r.score === topScore
                                ? '1.5px solid var(--accent)'
                                : '1px solid var(--border)',
                            fontWeight: 700,
                          }}
                        >
                          <span>
                            {r.score === topScore ? '🏆' : `#${i + 1}`} {r.name}
                          </span>
                          <span>{formatSigned(r.score)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={copySummary}>
                    📋 Copy Summary
                  </button>
                  <button
                    className="btn btn-blue"
                    style={{ flex: 1 }}
                    onClick={() => {
                      setSeats(activeGame.players);
                      setView('setup');
                    }}
                  >
                    Rematch (Same 5)
                  </button>
                </div>
              </section>
            )}
          </div>

          {/* Right Column: Ruled Notebook Score Sheet */}
          <div className="notebook">
            <div className="notebook-header">
              <span>📓 Score Sheet (Tap any row to edit)</span>
              <span>{activeGame.rounds.length}/19</span>
            </div>
            <table className="notebook-table">
              <thead>
                <tr>
                  {activeGame.players.map((p) => (
                    <th key={p.id}>{p.name}</th>
                  ))}
                  <th className="cell-cards">Cards</th>
                </tr>
              </thead>
              <tbody>
                {activeGame.rounds.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 20, color: '#64748b' }}>
                      No rounds completed yet.
                    </td>
                  </tr>
                ) : (
                  activeGame.rounds.map((r, idx) => {
                    const showSubtotal = SUBTOTAL_AFTER_ROUNDS.has(r.roundNumber);
                    const subtotals = showSubtotal
                      ? computeTotals(activeGame.rounds, idx + 1)
                      : null;
                    const isFinal = r.roundNumber === 19;
                    const finalTotals = isFinal ? computeTotals(activeGame.rounds) : null;

                    return (
                      <React.Fragment key={r.roundNumber}>
                        {r.roundNumber === 11 && (
                          <tr className="reversal-divider">
                            <td colSpan={6}>
                              🔄 ROTATION REVERSED (
                              {activeGame.initial_dir === 'CW'
                                ? 'CW → ACW'
                                : 'ACW → CW'}
                              )
                            </td>
                          </tr>
                        )}
                        <tr className="round-row" onClick={() => openRoundEditor(idx)}>
                          {r.bids.map((bid, pIdx) => {
                            const res = scoreEntry(bid, r.won[pIdx]);
                            return (
                              <td
                                key={pIdx}
                                className={res.hit ? 'cell-hit' : 'cell-miss'}
                              >
                                {res.notation}
                              </td>
                            );
                          })}
                          <td className="cell-cards">{r.cards}</td>
                        </tr>
                        {subtotals && (
                          <tr className="subtotal-row">
                            {subtotals.map((t, pIdx) => (
                              <td key={pIdx}>{formatSigned(t)}</td>
                            ))}
                            <td className="cell-cards">Σ</td>
                          </tr>
                        )}
                        {finalTotals && (
                          <tr className="final-row">
                            {finalTotals.map((t, pIdx) => (
                              <td key={pIdx}>{formatSigned(t)}</td>
                            ))}
                            <td className="cell-cards">END</td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== HISTORY VIEW ==================== */}
      {view === 'history' && (
        <section className="card">
          <div className="card-title">
            <span>Saved Games</span>
            <button className="btn btn-sm" onClick={loadAllData}>
              ↻ Refresh
            </button>
          </div>

          {games.length === 0 ? (
            <p className="muted">No games recorded in the database yet.</p>
          ) : (
            games.map((g) => {
              const totals = computeTotals(g.rounds);
              return (
                <div key={g.id} className="history-item">
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {g.status === 'completed' ? '🏆' : '🟢'} Game #{g.id} •{' '}
                      {g.rounds.length}/19 rounds
                      {g.winner_names.length > 0 && ` • Winner: ${g.winner_names.join(', ')}`}
                    </div>
                    <div className="muted">
                      {g.players
                        .map((p, idx) => `${p.name} (${formatSigned(totals[idx])})`)
                        .join(' • ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm btn-primary" onClick={() => openGame(g)}>
                      {g.status === 'completed' ? 'View Sheet' : 'Resume'}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleDeleteGame(g.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}

      {/* ==================== 19-ROUND SCHEDULE MODAL ==================== */}
      {showSchedule && activeGame && (
        <div className="modal-backdrop" onClick={() => setShowSchedule(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">
              <span>19-Round Serving & Turn Schedule</span>
              <button className="btn btn-sm" onClick={() => setShowSchedule(false)}>
                Close
              </button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)' }}>
                  <th style={{ padding: 6 }}>Rd</th>
                  <th>Cards</th>
                  <th>Dir</th>
                  <th>🃏 Serving</th>
                  <th>▶ 1st Player</th>
                </tr>
              </thead>
              <tbody>
                {ROUND_CARDS.map((_, idx) => {
                  const m = getRoundMeta(idx, activeGame.first_player_idx, activeGame.initial_dir);
                  const isCurrent = idx === activeGame.rounds.length;
                  return (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: '1px solid var(--border)',
                        background: isCurrent ? 'rgba(59,130,246,0.18)' : 'transparent',
                        textAlign: 'center',
                      }}
                    >
                      <td style={{ padding: 6, fontWeight: 700 }}>{m.roundNumber}</td>
                      <td>{m.cards}</td>
                      <td>{m.activeDir === 'CW' ? '↻' : '↺'}</td>
                      <td>{activeGame.players[m.serverIdx].name}</td>
                      <td>{activeGame.players[m.starterIdx].name}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== EDIT ROUND MODAL ==================== */}
      {editingRoundIdx !== null && activeGame && (
        <div className="modal-backdrop" onClick={() => setEditingRoundIdx(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">
              <span>
                Edit Round {editingRoundIdx + 1} ({ROUND_CARDS[editingRoundIdx]} cards)
              </span>
              <button className="btn btn-sm" onClick={() => setEditingRoundIdx(null)}>
                Cancel
              </button>
            </div>

            {activeGame.players.map((p, idx) => (
              <div key={p.id} className="turn-row">
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{p.name}</div>
                <div className="muted" style={{ marginBottom: 4 }}>Bid:</div>
                <div className="num-grid" style={{ marginBottom: 8 }}>
                  {Array.from({ length: ROUND_CARDS[editingRoundIdx] + 1 }, (_, n) => (
                    <button
                      key={n}
                      className={`num-btn ${editBids[idx] === n ? 'selected' : ''}`}
                      onClick={() => {
                        const next = [...editBids];
                        next[idx] = n;
                        setEditBids(next);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="muted" style={{ marginBottom: 4 }}>Tricks Won:</div>
                <div className="num-grid">
                  {Array.from({ length: ROUND_CARDS[editingRoundIdx] + 1 }, (_, n) => (
                    <button
                      key={n}
                      className={`num-btn ${editWon[idx] === n ? 'selected' : ''}`}
                      onClick={() => {
                        const next = [...editWon];
                        next[idx] = n;
                        setEditWon(next);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <button
              className="btn btn-primary"
              style={{ width: '100%', padding: 12, marginTop: 6 }}
              onClick={saveEditedRound}
            >
              Save Changes (Won: {editWon.reduce((a, b) => a + b, 0)}/{ROUND_CARDS[editingRoundIdx]})
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
