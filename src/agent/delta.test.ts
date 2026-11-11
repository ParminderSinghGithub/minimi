import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateDelta } from './deltaEvaluator.js';
import { ChatAgent } from './orchestrator.js';
import { MemoryStore } from '../memory/db.js';
import { MockSearchProvider } from '../tools/search.js';
import type { Message, SearchResultItem, Citation } from '../types/index.js';

describe('Delta Evaluator', () => {
  const historicalMessages: Message[] = [
    {
      id: 'h-1',
      sessionId: 'sess-1',
      role: 'user',
      content: 'What is Supabase Pro pricing?',
      createdAt: '2026-11-03T10:00:00.000Z',
    },
    {
      id: 'h-2',
      sessionId: 'sess-1',
      role: 'assistant',
      content: 'Supabase Pro starts at $25/month including $10 in compute credits.',
      createdAt: '2026-11-03T10:01:00.000Z',
    },
  ];

  it('should return CONFIRMED_UNCHANGED when live search actively confirms historical pricing with interval-spanning dated evidence', () => {
    const searchResults: SearchResultItem[] = [
      {
        id: 's-1',
        title: 'Supabase Pricing',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25/month with 8GB database space included.',
        publishedDate: '2026-11-05',
        category: 'pricing',
        retrievedAt: new Date().toISOString(),
        isMock: false,
      },
    ];

    const citations: Citation[] = [
      {
        id: 1,
        title: 'Supabase Pricing',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25/month with 8GB database space included.',
        publishedDate: '2026-11-05',
        isMock: false,
      },
    ];

    const delta = evaluateDelta({
      userQuery: 'Is your answer still correct today?',
      historicalMessages,
      searchResults,
      citations,
      temporal: {
        expression: '3 November',
        startDate: '2026-11-03T00:00:00.000Z',
        endDate: '2026-11-03T23:59:59.999Z',
        isRange: false,
        confidence: 0.95,
        referenceTimestamp: '2026-11-11T12:00:00.000Z',
        timezone: 'UTC',
      },
    });

    expect(delta).toBeDefined();
    expect(delta?.status).toBe('CONFIRMED_UNCHANGED');
    expect(delta?.explanation).toContain('$25/month');
  });

  it('should return INCONCLUSIVE_NO_EVIDENCE when official domain has matching price but lacks interval-spanning dated proof', () => {
    const searchResults: SearchResultItem[] = [
      {
        id: 's-undated-official',
        title: 'Supabase Pricing Page',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25/month.',
        category: 'pricing',
        retrievedAt: new Date().toISOString(),
        isMock: false,
        // No publishedDate provided
      },
    ];

    const citations: Citation[] = [
      {
        id: 1,
        title: 'Supabase Pricing Page',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25/month.',
        isMock: false,
      },
    ];

    const delta = evaluateDelta({
      userQuery: 'Is your answer still correct today?',
      historicalMessages,
      searchResults,
      citations,
    });

    expect(delta).toBeDefined();
    expect(delta?.status).toBe('INCONCLUSIVE_NO_EVIDENCE');
    expect(delta?.explanation).toContain('current price alone cannot establish');
  });

  it('should return DEMO_SIMULATION when search results are from mock/simulated fixtures', () => {
    const searchResults: SearchResultItem[] = [
      {
        id: 'mock-1',
        title: 'Supabase Pricing Simulation',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25/month.',
        publishedDate: '2026-11-05',
        category: 'pricing',
        retrievedAt: new Date().toISOString(),
        isMock: true,
      },
    ];

    const citations: Citation[] = [
      {
        id: 1,
        title: 'Supabase Pricing Simulation',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25/month.',
        isMock: true,
      },
    ];

    const delta = evaluateDelta({
      userQuery: 'Is your answer still correct today?',
      historicalMessages,
      searchResults,
      citations,
    });

    expect(delta).toBeDefined();
    expect(delta?.status).toBe('DEMO_SIMULATION');
    expect(delta?.isMock).toBe(true);
    expect(delta?.explanation).toContain('Demo Simulation Active');
  });

  it('should return INCONCLUSIVE_NO_EVIDENCE when price matches but lacks dated confirmation and official domain', () => {
    const searchResults: SearchResultItem[] = [
      {
        id: 's-undated',
        title: 'Random Tech Blog',
        url: 'https://random-blog.net/cloud-review',
        snippet: 'In our review, Supabase Pro starts at $25/month.',
        category: 'pricing',
        retrievedAt: new Date().toISOString(),
        // No publishedDate provided
      },
    ];

    const citations: Citation[] = [
      {
        id: 1,
        title: 'Random Tech Blog',
        url: 'https://random-blog.net/cloud-review',
        snippet: 'In our review, Supabase Pro starts at $25/month.',
      },
    ];

    const delta = evaluateDelta({
      userQuery: 'Is your answer still correct today?',
      historicalMessages,
      searchResults,
      citations,
    });

    expect(delta).toBeDefined();
    expect(delta?.status).toBe('INCONCLUSIVE_NO_EVIDENCE');
    expect(delta?.explanation).toContain('lack interval-spanning dated confirmation');
  });

  it('should return VERIFIED_CHANGE when pricing or feature updates are detected', () => {
    const searchResults: SearchResultItem[] = [
      {
        id: 's-change',
        title: 'Supabase Pricing Update',
        url: 'https://supabase.com/pricing',
        snippet: 'Supabase Pro is now $35/month starting November 2026.',
        category: 'pricing',
        retrievedAt: new Date().toISOString(),
      },
    ];

    const citations: Citation[] = [
      {
        id: 1,
        title: 'Supabase Pricing Update',
        url: 'https://supabase.com/pricing',
        snippet: 'Supabase Pro is now $35/month starting November 2026.',
      },
    ];

    const delta = evaluateDelta({
      userQuery: 'Has pricing changed since then?',
      historicalMessages,
      searchResults,
      citations,
    });

    expect(delta).toBeDefined();
    expect(delta?.status).toBe('VERIFIED_CHANGE');
    expect(delta?.explanation).toContain('pricing changes');
  });

  it('should return INCONCLUSIVE_NO_EVIDENCE when search results are empty and never claim unchanged', () => {
    const delta = evaluateDelta({
      userQuery: 'Is your answer still correct today?',
      historicalMessages,
      searchResults: [],
      citations: [],
    });

    expect(delta).toBeDefined();
    expect(delta?.status).toBe('INCONCLUSIVE_NO_EVIDENCE');
    expect(delta?.explanation).toContain('Absence of search results cannot be treated as confirmation');
  });
});

describe('ChatAgent Orchestrator Integration', () => {
  let memoryStore: MemoryStore;
  let mockSearch: MockSearchProvider;
  let agent: ChatAgent;
  const anchor = new Date('2026-11-11T12:00:00.000Z');

  beforeEach(async () => {
    memoryStore = new MemoryStore(':memory:');
    await memoryStore.initialize();
    mockSearch = new MockSearchProvider();
    agent = new ChatAgent({
      memoryStore,
      searchProvider: mockSearch,
      timezone: 'UTC',
    });
  });

  it('should handle Challenge Prompt 1: CRM tools shortlisted on Monday', async () => {
    const sessionId = 'test-challenge-1';
    memoryStore.seedChallengeDemoData(sessionId, anchor);

    const res = await agent.handleUserMessage(
      sessionId,
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
      anchor
    );

    expect(res.memoryContextUsed.messageCount).toBeGreaterThan(0);
    expect(res.searchesExecuted.length).toBeGreaterThan(0);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.content).toContain('HubSpot');
    expect(res.content).toContain('Sources & Citations');
  });

  it('should handle Challenge Prompt 2: Nov 3 Postgres query verification', async () => {
    const sessionId = 'test-challenge-2';
    memoryStore.seedChallengeDemoData(sessionId, anchor);

    const res = await agent.handleUserMessage(
      sessionId,
      'What did I ask you on 3 November? Is your answer still correct today?',
      anchor
    );

    expect(res.memoryContextUsed.messageCount).toBeGreaterThan(0);
    expect(res.delta).toBeDefined();
    expect(res.content).toContain('Supabase');
    expect(res.content).toContain('Sources & Citations');
  });

  it('should handle Challenge Prompt 3: Last Tuesday Postgres hosting pricing', async () => {
    const sessionId = 'test-challenge-3';
    memoryStore.seedChallengeDemoData(sessionId, anchor);

    const res = await agent.handleUserMessage(
      sessionId,
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      anchor
    );

    expect(res.memoryContextUsed.messageCount).toBeGreaterThan(0);
    expect(res.searchesExecuted.some(s => s.targetEntity === 'neon' || s.targetEntity === 'supabase' || s.query.includes('postgres'))).toBe(true);
    expect(res.citations.length).toBeGreaterThan(0);
  });

  it('should gracefully state missing history without hallucinating when no prior turns exist', async () => {
    const emptySessionId = 'fresh-empty-session';

    const res = await agent.handleUserMessage(
      emptySessionId,
      'What did I ask you on 3 November? Is your answer still correct today?',
      anchor
    );

    expect(res.memoryContextUsed.messageCount).toBe(0);
    expect(res.content).toContain('No prior conversation history found for date range');
    // Verifies it did NOT hallucinate a fake conversation
    expect(res.content).not.toContain('You asked: "');
  });

  it('should isolate fresh search queries without polluting from unrelated prior memory', async () => {
    const sessionId = 'seeded-session-for-fresh-query';
    memoryStore.seedChallengeDemoData(sessionId, anchor); // Contains CRM and Postgres messages

    // Now user asks a fresh question about Linear app pricing
    const res = await agent.handleUserMessage(
      sessionId,
      'What is the current pricing for Linear app standard and plus plans?',
      anchor
    );

    // Should NOT search for Postgres or Supabase
    const searchedTerms = res.searchesExecuted.map(s => s.query.toLowerCase()).join(' ');
    expect(searchedTerms).toContain('linear');
    expect(searchedTerms).not.toContain('postgres');
    expect(searchedTerms).not.toContain('supabase');

    // Should NOT create a phantom delta comparison against Postgres
    expect(res.delta).toBeUndefined();
  });
});
