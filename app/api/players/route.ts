import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getDb, parseJsonField } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureSchema();
    const db = getDb();

    const playersResult = await db.execute(
      'SELECT id, name, created_at FROM players ORDER BY LOWER(name) ASC'
    );

    const completedResult = await db.execute(
      "SELECT players, winner_names FROM games WHERE status = 'completed'"
    );

    const stats = new Map<string, { gamesPlayed: number; wins: number }>();

    for (const g of completedResult.rows) {
      const gamePlayers = parseJsonField<{ id?: number; name: string }[]>(g.players, []);
      const winners = new Set(
        parseJsonField<string[]>(g.winner_names, []).map((w) => w.toLowerCase())
      );
      for (const p of gamePlayers) {
        const key = p.name.toLowerCase();
        const curr = stats.get(key) ?? { gamesPlayed: 0, wins: 0 };
        curr.gamesPlayed += 1;
        if (winners.has(key)) curr.wins += 1;
        stats.set(key, curr);
      }
    }

    const enriched = playersResult.rows.map((p) => {
      const s = stats.get(String(p.name).toLowerCase()) ?? { gamesPlayed: 0, wins: 0 };
      return {
        id: Number(p.id),
        name: String(p.name),
        gamesPlayed: s.gamesPlayed,
        wins: s.wins,
      };
    });

    return NextResponse.json({ players: enriched });
  } catch (error) {
    console.error('GET /api/players error:', error);
    return NextResponse.json({ error: 'Failed to load players' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureSchema();
    const body = await request.json();
    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';

    if (!rawName || rawName.length > 32) {
      return NextResponse.json(
        { error: 'Player name must be between 1 and 32 characters.' },
        { status: 400 }
      );
    }

    const db = getDb();
    const existing = await db.execute({
      sql: 'SELECT id, name FROM players WHERE LOWER(name) = LOWER(?) LIMIT 1',
      args: [rawName],
    });

    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: `"${existing.rows[0].name}" is already in the roster.`, player: existing.rows[0] },
        { status: 409 }
      );
    }

    const inserted = await db.execute({
      sql: 'INSERT INTO players (name) VALUES (?) RETURNING id, name',
      args: [rawName],
    });

    return NextResponse.json(
      {
        player: {
          id: Number(inserted.rows[0].id),
          name: String(inserted.rows[0].name),
          gamesPlayed: 0,
          wins: 0,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('POST /api/players error:', error);
    return NextResponse.json({ error: 'Failed to add player' }, { status: 500 });
  }
}
