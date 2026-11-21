import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getDb, parseJsonField } from '@/lib/db';
import { getWinners, type Direction, type PlayerRef, type RoundRecord } from '@/lib/game-engine';

export const dynamic = 'force-dynamic';

function serializeGame(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    players: parseJsonField<PlayerRef[]>(row.players, []),
    first_player_idx: Number(row.first_player_idx),
    initial_dir: (row.initial_dir === 'ACW' ? 'ACW' : 'CW') as Direction,
    rounds: parseJsonField<RoundRecord[]>(row.rounds, []),
    status: row.status === 'completed' ? 'completed' : 'active',
    winner_names: parseJsonField<string[]>(row.winner_names, []),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: 'Invalid game ID' }, { status: 400 });
    }

    const db = getDb();
    const result = await db.execute({
      sql: 'SELECT id, players, first_player_idx, initial_dir, rounds, status, winner_names, created_at, updated_at FROM games WHERE id = ? LIMIT 1',
      args: [numId],
    });
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Game not found' }, { status: 404 });
    }
    return NextResponse.json({ game: serializeGame(result.rows[0] as Record<string, unknown>) });
  } catch (error) {
    console.error('GET /api/games/[id] error:', error);
    return NextResponse.json({ error: 'Failed to load game' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: 'Invalid game ID' }, { status: 400 });
    }

    const body = await request.json();
    const rounds: RoundRecord[] = Array.isArray(body?.rounds) ? body.rounds : [];

    const db = getDb();
    const existing = await db.execute({
      sql: 'SELECT players FROM games WHERE id = ? LIMIT 1',
      args: [numId],
    });
    if (existing.rows.length === 0) {
      return NextResponse.json({ error: 'Game not found' }, { status: 404 });
    }

    const players = parseJsonField<PlayerRef[]>(existing.rows[0].players, []);
    const status = rounds.length >= 19 ? 'completed' : 'active';
    const winners = getWinners(players, rounds);

    const updated = await db.execute({
      sql: `UPDATE games
            SET rounds = ?, status = ?, winner_names = ?, updated_at = datetime('now')
            WHERE id = ?
            RETURNING id, players, first_player_idx, initial_dir, rounds, status, winner_names, created_at, updated_at`,
      args: [JSON.stringify(rounds), status, JSON.stringify(winners), numId],
    });

    return NextResponse.json({ game: serializeGame(updated.rows[0] as Record<string, unknown>) });
  } catch (error) {
    console.error('PATCH /api/games/[id] error:', error);
    return NextResponse.json({ error: 'Failed to update game' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: 'Invalid game ID' }, { status: 400 });
    }

    const db = getDb();
    await db.execute({
      sql: 'DELETE FROM games WHERE id = ?',
      args: [numId],
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /api/games/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete game' }, { status: 500 });
  }
}
