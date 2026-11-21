import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getDb, parseJsonField } from '@/lib/db';
import type { Direction, PlayerRef, RoundRecord } from '@/lib/game-engine';

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

export async function GET() {
  try {
    await ensureSchema();
    const db = getDb();
    const result = await db.execute(
      'SELECT id, players, first_player_idx, initial_dir, rounds, status, winner_names, created_at, updated_at FROM games ORDER BY updated_at DESC LIMIT 30'
    );
    return NextResponse.json({
      games: result.rows.map((row) => serializeGame(row as Record<string, unknown>)),
    });
  } catch (error) {
    console.error('GET /api/games error:', error);
    return NextResponse.json({ error: 'Failed to load games' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureSchema();
    const body = await request.json();
    const players: PlayerRef[] = Array.isArray(body?.players) ? body.players : [];
    const firstPlayerIdx = Number(body?.first_player_idx ?? 0);
    const initialDir: Direction = body?.initial_dir === 'ACW' ? 'ACW' : 'CW';

    if (players.length !== 5) {
      return NextResponse.json({ error: 'Exactly 5 players are required.' }, { status: 400 });
    }
    if (!Number.isInteger(firstPlayerIdx) || firstPlayerIdx < 0 || firstPlayerIdx > 4) {
      return NextResponse.json({ error: 'Invalid first_player_idx.' }, { status: 400 });
    }

    const db = getDb();
    const result = await db.execute({
      sql: `INSERT INTO games (players, first_player_idx, initial_dir, rounds, status, winner_names)
            VALUES (?, ?, ?, '[]', 'active', '[]')
            RETURNING id, players, first_player_idx, initial_dir, rounds, status, winner_names, created_at, updated_at`,
      args: [JSON.stringify(players), firstPlayerIdx, initialDir],
    });

    return NextResponse.json(
      { game: serializeGame(result.rows[0] as Record<string, unknown>) },
      { status: 201 }
    );
  } catch (error) {
    console.error('POST /api/games error:', error);
    return NextResponse.json({ error: 'Failed to create game' }, { status: 500 });
  }
}
