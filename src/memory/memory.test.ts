import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTemporalExpression, extractKeywords } from './temporal.js';
import { MemoryStore } from './db.js';

describe('Temporal Expression Resolver', () => {
  // Fix anchor date to Wednesday, Nov 11, 2026 12:00:00 UTC
  const anchor = new Date('2026-11-11T12:00:00.000Z');

  it('should resolve "today" to the anchor day boundaries', () => {
    const res = resolveTemporalExpression('What is on my calendar today?', anchor, 'UTC');
    expect(res.temporal).toBeDefined();
    expect(res.temporal?.expression).toBe('today');
    expect(res.temporal?.startDate).toBe('2026-11-11T00:00:00.000Z');
    expect(res.temporal?.endDate).toBe('2026-11-11T23:59:59.999Z');
  });

  it('should resolve "yesterday" accurately', () => {
    const res = resolveTemporalExpression('What did we discuss yesterday?', anchor, 'UTC');
    expect(res.temporal).toBeDefined();
    expect(res.temporal?.expression).toBe('yesterday');
    expect(res.temporal?.startDate).toBe('2026-11-10T00:00:00.000Z');
    expect(res.temporal?.endDate).toBe('2026-11-10T23:59:59.999Z');
  });

  it('should resolve "on Monday" when today is Wednesday (2 days prior)', () => {
    const res = resolveTemporalExpression(
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
      anchor,
      'UTC'
    );
    expect(res.temporal).toBeDefined();
    expect(res.temporal?.expression).toMatch(/monday/i);
    // Wednesday Nov 11 -> Monday Nov 9
    expect(res.temporal?.startDate).toBe('2026-11-09T00:00:00.000Z');
    expect(res.temporal?.endDate).toBe('2026-11-09T23:59:59.999Z');
    expect(res.extractedKeywords).toContain('crm');
    expect(res.extractedKeywords).toContain('shortlisted');
  });

  it('should resolve "last Tuesday" when today is Wednesday (preceding Tuesday)', () => {
    const res = resolveTemporalExpression(
      'Last Tuesday I asked you about Postgres hosting.',
      anchor,
      'UTC'
    );
    expect(res.temporal).toBeDefined();
    expect(res.temporal?.expression).toMatch(/last tuesday/i);
    // Wednesday Nov 11 -> Tuesday Nov 10
    expect(res.temporal?.startDate).toBe('2026-11-10T00:00:00.000Z');
    expect(res.temporal?.endDate).toBe('2026-11-10T23:59:59.999Z');
    expect(res.extractedKeywords).toContain('postgres');
    expect(res.extractedKeywords).toContain('hosting');
  });

  it('should resolve exact date "3 November"', () => {
    const res = resolveTemporalExpression(
      'What did I ask you on 3 November? Is your answer still correct today?',
      anchor,
      'UTC'
    );
    expect(res.temporal).toBeDefined();
    expect(res.temporal?.expression).toMatch(/3 november/i);
    expect(res.temporal?.startDate).toBe('2026-11-03T00:00:00.000Z');
    expect(res.temporal?.endDate).toBe('2026-11-03T23:59:59.999Z');
  });

  it('should resolve ISO date "2026-11-03"', () => {
    const res = resolveTemporalExpression(
      'Show notes from 2026-11-03 regarding billing',
      anchor,
      'UTC'
    );
    expect(res.temporal).toBeDefined();
    expect(res.temporal?.startDate).toBe('2026-11-03T00:00:00.000Z');
    expect(res.temporal?.endDate).toBe('2026-11-03T23:59:59.999Z');
  });

  it('should extract meaningful keywords ignoring conversational stopwords', () => {
    const kws = extractKeywords('On Monday we shortlisted 5 CRM tools for a 20-person sales team.');
    expect(kws).toContain('crm');
    expect(kws).toContain('tools');
    expect(kws).toContain('sales');
    expect(kws).not.toContain('we');
    expect(kws).not.toContain('for');
  });
});

describe('MemoryStore (SQLite + FTS4 + Temporal Filter)', () => {
  let memory: MemoryStore;
  const anchor = new Date('2026-11-11T12:00:00.000Z');

  beforeEach(async () => {
    memory = new MemoryStore(':memory:');
    await memory.initialize();
  });

  it('should create sessions and add messages', () => {
    const session = memory.createSession('sess-1', 'Test Session');
    expect(session.id).toBe('sess-1');

    const msg = memory.addMessage({
      id: 'm1',
      sessionId: 'sess-1',
      role: 'user',
      content: 'We need to benchmark vector databases',
      createdAt: '2026-11-11T10:00:00.000Z',
    });
    expect(msg.id).toBe('m1');

    const history = memory.getRecentMessages('sess-1');
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('We need to benchmark vector databases');
  });

  it('should filter messages by chronological window', () => {
    memory.createSession('sess-chrono');

    memory.addMessage({
      id: 'm-old',
      sessionId: 'sess-chrono',
      role: 'user',
      content: 'Old message from October',
      createdAt: '2026-10-15T10:00:00.000Z',
    });

    memory.addMessage({
      id: 'm-target',
      sessionId: 'sess-chrono',
      role: 'user',
      content: 'Target message on Nov 3',
      createdAt: '2026-11-03T14:00:00.000Z',
    });

    const result = memory.searchMemory({
      sessionId: 'sess-chrono',
      temporal: {
        expression: '3 November',
        startDate: '2026-11-03T00:00:00.000Z',
        endDate: '2026-11-03T23:59:59.999Z',
        isRange: false,
        confidence: 1.0,
        referenceTimestamp: anchor.toISOString(),
        timezone: 'UTC',
      },
    });

    expect(result.hasExactMatch).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('m-target');
  });

  it('should reliably report missing conversation history without fabricating', () => {
    memory.createSession('sess-empty');

    const result = memory.searchMemory({
      sessionId: 'sess-empty',
      temporal: {
        expression: '3 November',
        startDate: '2026-11-03T00:00:00.000Z',
        endDate: '2026-11-03T23:59:59.999Z',
        isRange: false,
        confidence: 1.0,
        referenceTimestamp: anchor.toISOString(),
        timezone: 'UTC',
      },
    });

    expect(result.hasExactMatch).toBe(false);
    expect(result.messages).toHaveLength(0);
    expect(result.explanation).toContain('No prior conversation history found for date range');
  });

  it('should search memory using FTS keyword matching', () => {
    memory.createSession('sess-fts');

    memory.addMessage({
      id: 'm-crm',
      sessionId: 'sess-fts',
      role: 'user',
      content: 'Shortlist 5 CRM tools including HubSpot and Salesforce',
      createdAt: '2026-11-09T10:00:00.000Z',
    });

    memory.addMessage({
      id: 'm-postgres',
      sessionId: 'sess-fts',
      role: 'user',
      content: 'What is the pricing for Supabase Postgres hosting?',
      createdAt: '2026-11-10T10:00:00.000Z',
    });

    const crmResult = memory.searchMemory({
      sessionId: 'sess-fts',
      keywords: ['crm'],
    });

    expect(crmResult.hasExactMatch).toBe(true);
    expect(crmResult.messages.some(m => m.id === 'm-crm')).toBe(true);
    expect(crmResult.messages.some(m => m.id === 'm-postgres')).toBe(false);
  });

  it('should verify challenge demo dataset seeding', () => {
    const demoSessionId = 'demo-test-session';
    memory.seedChallengeDemoData(demoSessionId, anchor);

    const history = memory.getRecentMessages(demoSessionId);
    expect(history.length).toBeGreaterThanOrEqual(6); // 3 pairs of user + assistant turns

    // Test Challenge Query 1: "On Monday we shortlisted 5 CRM tools"
    const crmSearch = memory.searchMemory({
      sessionId: demoSessionId,
      keywords: ['crm', 'shortlisted'],
    });
    expect(crmSearch.hasExactMatch).toBe(true);
    expect(crmSearch.messages[0].content).toContain('CRM');

    // Test Challenge Query 2: "What did I ask you on 3 November?"
    const nov3Search = memory.searchMemory({
      sessionId: demoSessionId,
      temporal: {
        expression: '3 November',
        startDate: '2026-11-03T00:00:00.000Z',
        endDate: '2026-11-03T23:59:59.999Z',
        isRange: false,
        confidence: 0.95,
        referenceTimestamp: anchor.toISOString(),
        timezone: 'UTC',
      },
    });
    expect(nov3Search.hasExactMatch).toBe(true);
    expect(nov3Search.messages[0].content).toContain('Supabase');

    // Test Challenge Query 3: "Last Tuesday I asked you about Postgres hosting"
    const tuesdaySearch = memory.searchMemory({
      sessionId: demoSessionId,
      keywords: ['postgres', 'hosting'],
    });
    expect(tuesdaySearch.hasExactMatch).toBe(true);
    expect(tuesdaySearch.messages.some(m => m.content.includes('Postgres'))).toBe(true);
  });

  it('should return the latest N messages in ascending chronological order when limit is reached', () => {
    const sessId = 'sess-ordering';
    memory.createSession(sessId);

    // Insert 5 timestamped messages
    for (let i = 1; i <= 5; i++) {
      memory.addMessage({
        id: `msg-${i}`,
        sessionId: sessId,
        role: 'user',
        content: `Message number ${i}`,
        createdAt: `2026-11-11T10:0${i}:00.000Z`,
      });
    }

    // Request the 3 most recent messages
    const recent = memory.getRecentMessages(sessId, 3);
    expect(recent).toHaveLength(3);
    // Must be msg-3, msg-4, msg-5 in chronological order
    expect(recent[0].id).toBe('msg-3');
    expect(recent[1].id).toBe('msg-4');
    expect(recent[2].id).toBe('msg-5');
  });

  it('should strictly isolate sessions during temporal fallback and prevent cross-session leaks', () => {
    const sessionA = 'session-private-a';
    const sessionB = 'session-isolated-b';
    memory.createSession(sessionA);
    memory.createSession(sessionB);

    // Add private message in session A on Nov 3
    memory.addMessage({
      id: 'private-msg-a',
      sessionId: sessionA,
      role: 'user',
      content: 'Confidential strategic pricing for CRM in session A',
      createdAt: '2026-11-03T10:00:00.000Z',
    });

    // Session B queries Nov 3 with an unmatched keyword, triggering temporal fallback
    const resultB = memory.searchMemory({
      sessionId: sessionB,
      keywords: ['unmatched_keyword_xyz'],
      temporal: {
        expression: '3 November',
        startDate: '2026-11-03T00:00:00.000Z',
        endDate: '2026-11-03T23:59:59.999Z',
        isRange: false,
        confidence: 0.95,
        referenceTimestamp: anchor.toISOString(),
        timezone: 'UTC',
      },
    });

    // Session B must NOT receive Session A's message
    expect(resultB.messages).toHaveLength(0);
    expect(resultB.hasExactMatch).toBe(false);
  });
});

