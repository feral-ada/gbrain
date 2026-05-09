/**
 * v0.31 Phase 6 — Garry's Separation Test (PRIMARY ship gate, PGLite).
 *
 * Insert a fact via session A; recall it from session B; the brain
 * remembers across sessions. PGLite in-memory; no DATABASE_URL.
 *
 * Postgres parity in test/e2e/facts-separation-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe("Garry's Separation Test (PGLite)", () => {
  test('fact inserted in session A is visible from session B (cross-session, same source)', async () => {
    // 7 AM: in topic-2659, Garry says "I'm flying to Tokyo Tuesday".
    await engine.insertFact(
      {
        fact: "flying to Tokyo Tuesday",
        kind: 'event',
        entity_slug: 'travel',
        source: 'mcp:extract_facts',
        source_session: 'topic-2659',
        visibility: 'world',
      },
      { source_id: 'default' },
    );

    // 2 PM: in topic-1941, Garry asks "what's on my schedule?".
    // Recall by entity (cross-session retrieval — session is data, not key).
    const byEntity = await engine.listFactsByEntity('default', 'travel');
    expect(byEntity.length).toBe(1);
    expect(byEntity[0].fact).toBe('flying to Tokyo Tuesday');
    expect(byEntity[0].source_session).toBe('topic-2659');

    // Recall by recency (--since "8 hours ago").
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const bySince = await engine.listFactsSince('default', eightHoursAgo);
    expect(bySince.find(f => f.fact === 'flying to Tokyo Tuesday')).toBeDefined();

    // Recall by the OLD session id (admin reviewing a session).
    const sessionA = await engine.listFactsBySession('default', 'topic-2659');
    expect(sessionA.length).toBe(1);

    // Recall by the NEW session id returns nothing — session is data, not
    // a partition. Cross-session continuity comes from entity / since.
    const sessionB = await engine.listFactsBySession('default', 'topic-1941');
    expect(sessionB.length).toBe(0);
  });

  test('expired facts are hidden from default recall, surfaced via include-expired', async () => {
    const inserted = await engine.insertFact(
      { fact: 'expired fact', kind: 'fact', entity_slug: 'expired-test', source: 'test' },
      { source_id: 'default' },
    );
    await engine.expireFact(inserted.id);

    const active = await engine.listFactsByEntity('default', 'expired-test');
    expect(active.length).toBe(0);
    const all = await engine.listFactsByEntity('default', 'expired-test', { activeOnly: false });
    expect(all.length).toBe(1);
    expect(all[0].expired_at).not.toBeNull();
  });
});
