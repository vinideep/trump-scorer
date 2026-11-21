import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: 'Invalid player ID' }, { status: 400 });
    }

    const db = getDb();
    await db.execute({
      sql: 'DELETE FROM players WHERE id = ?',
      args: [numId],
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /api/players/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete player' }, { status: 500 });
  }
}
