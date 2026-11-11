import { describe, it, expect } from 'vitest';
import { MockSearchProvider, buildCitations, createSearchProvider } from './search.js';
import {
  planSearchQueries,
  extractTargetEntities,
  executeSearchPlans,
} from '../agent/searchPlanner.js';
import type { Message, TemporalResolution } from '../types/index.js';

describe('Web Search Tool & Search Planner', () => {
  const mockTemporal: TemporalResolution = {
    expression: 'on Monday',
    startDate: '2026-11-09T00:00:00.000Z',
    endDate: '2026-11-09T23:59:59.999Z',
    isRange: false,
    confidence: 0.95,
    referenceTimestamp: '2026-11-11T12:00:00.000Z',
    timezone: 'Asia/Kolkata',
  };

  const sampleMemoryMessages: Message[] = [
    {
      id: 'msg-crm-history',
      sessionId: 'sess-crm',
      role: 'assistant',
      content:
        'Shortlisted CRM tools: 1. HubSpot Sales Hub Pro 2. Salesforce Sales Cloud 3. Pipedrive 4. Zoho CRM 5. Close CRM',
      createdAt: '2026-11-09T10:30:00.000Z',
    },
  ];

  it('should extract target entities from conversation memory and user query', () => {
    const entities = extractTargetEntities(
      'Has any of them changed pricing or shipped something big since?',
      sampleMemoryMessages
    );

    expect(entities).toContain('hubspot');
    expect(entities).toContain('salesforce');
    expect(entities).toContain('pipedrive');
    expect(entities).toContain('zoho');
  });

  it('should extract unfamiliar multi-word tool names and app phrases', () => {
    const entities = extractTargetEntities('What is the current pricing for Linear app standard and plus plans?');
    expect(entities).toContain('linear');

    const quotedEntities = extractTargetEntities('Can you compare "Raycast Pro" with Alfred?');
    expect(quotedEntities).toContain('raycast pro');
  });

  it('should allocate intent-specific queries targeting official plans and changelogs', () => {
    const pricingPlans = planSearchQueries('What is the pricing for ClickUp?');
    expect(pricingPlans[0].category).toBe('pricing');
    expect(pricingPlans[0].query).toContain('pricing');

    const changelogPlans = planSearchQueries('What new features shipped for Supabase recently?');
    expect(changelogPlans[0].category).toBe('changelog');
    expect(changelogPlans[0].query).toContain('changelog');
  });

  it('should plan multiple targeted queries prioritizing pricing and changelogs', () => {
    const plans = planSearchQueries(
      'Has any of them changed pricing or shipped something big since?',
      sampleMemoryMessages,
      mockTemporal,
      { maxQueries: 5 }
    );

    expect(plans.length).toBeGreaterThanOrEqual(3);
    expect(plans.some(p => p.category === 'pricing')).toBe(true);
    expect(plans.some(p => p.category === 'changelog')).toBe(true);
    expect(plans.some(p => p.targetEntity === 'hubspot')).toBe(true);
  });

  it('should execute targeted search plans using MockSearchProvider', async () => {
    const provider = new MockSearchProvider();
    const plans = planSearchQueries(
      'Has any pricing changed for Supabase Postgres hosting?',
      [
        {
          id: 'msg-sb',
          sessionId: 'sess-1',
          role: 'assistant',
          content: 'Supabase Pro is $25/mo Postgres hosting.',
          createdAt: '2026-11-03T10:00:00.000Z',
        },
      ],
      mockTemporal
    );

    const execution = await executeSearchPlans(provider, plans);

    expect(execution.rawResults.length).toBeGreaterThan(0);
    expect(execution.citations.length).toBeGreaterThan(0);
    expect(execution.failedQueries).toHaveLength(0);

    const supabaseCitation = execution.citations.find(c => c.url.includes('supabase.com'));
    expect(supabaseCitation).toBeDefined();
    expect(supabaseCitation?.snippet).toContain('Supabase');
  });

  it('should handle search failures gracefully without crashing the turn', async () => {
    const provider = new MockSearchProvider();
    provider.setShouldFail(true); // First search will fail

    const plans = [
      {
        query: 'Supabase pricing',
        category: 'pricing' as const,
        intent: 'Check pricing',
      },
      {
        query: 'Neon pricing',
        category: 'pricing' as const,
        intent: 'Check pricing',
      },
    ];

    const execution = await executeSearchPlans(provider, plans);

    // One failed, but execution succeeded overall
    expect(execution.failedQueries).toHaveLength(1);
    expect(execution.failedQueries[0].query).toBe('Supabase pricing');
    expect(execution.rawResults.length).toBeGreaterThan(0); // Neon succeeded
  });

  it('should deduplicate URLs and preserve citation metadata', () => {
    const citations = buildCitations([
      {
        id: '1',
        title: 'Supabase Pricing',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25',
        publishedDate: '2026-11-01',
        retrievedAt: new Date().toISOString(),
      },
      {
        id: '2',
        title: 'Supabase Pricing Duplicate',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan starts at $25 duplicate',
        publishedDate: '2026-11-01',
        retrievedAt: new Date().toISOString(),
      },
      {
        id: '3',
        title: 'Supabase Changelog',
        url: 'https://supabase.com/changelog',
        snippet: 'November updates',
        publishedDate: '2026-11-05',
        retrievedAt: new Date().toISOString(),
      },
    ]);

    expect(citations).toHaveLength(2);
    expect(citations[0].url).toBe('https://supabase.com/pricing');
    expect(citations[1].url).toBe('https://supabase.com/changelog');
    expect(citations[0].publishedDate).toBe('2026-11-01');
  });

  it('should instantiate MockSearchProvider when API key is default or missing', () => {
    const provider = createSearchProvider('tavily', 'your_tavily_api_key_here');
    expect(provider.name).toBe('mock');
  });

  it('should clearly mark mock citations with [Demo Simulation] and isMock: true', () => {
    const citations = buildCitations([
      {
        id: 'mock-1',
        title: 'Supabase Pricing',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro plan is $25/mo',
        publishedDate: '2026-11-05',
        retrievedAt: new Date().toISOString(),
        isMock: true,
      },
    ]);

    expect(citations[0].isMock).toBe(true);
    expect(citations[0].title).toContain('[Demo Simulation]');
  });

  it('should fairly allocate queries across all 5 shortlisted CRM vendors under a 5-query budget', () => {
    const memoryMessages = [
      {
        id: 'crm-prev',
        sessionId: 'sess-crm',
        role: 'assistant' as const,
        content:
          '1. HubSpot Sales Hub Pro\n2. Salesforce Sales Cloud\n3. Pipedrive Professional\n4. Zoho CRM Enterprise\n5. Close CRM Growth',
        createdAt: '2026-11-09T10:30:00.000Z',
      },
    ];

    const plans = planSearchQueries(
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
      memoryMessages,
      undefined,
      { maxQueries: 5 }
    );

    expect(plans).toHaveLength(5);
    const targetEntities = plans.map(p => p.targetEntity?.toLowerCase());
    expect(targetEntities).toContain('hubspot');
    expect(targetEntities).toContain('salesforce');
    expect(targetEntities).toContain('pipedrive');
    expect(targetEntities).toContain('zoho');
    expect(targetEntities.some(e => e?.includes('close'))).toBe(true);
    expect(plans.isComplete).toBe(true);
    expect(plans.unsearchedEntities).toHaveLength(0);
  });

  it('should detect and disclose partial coverage when requested entities exceed the query budget', () => {
    const memoryMessages = [
      {
        id: 'tools-prev',
        sessionId: 'sess-tools',
        role: 'assistant' as const,
        content: 'HubSpot, Salesforce, Pipedrive, Zoho, Close, Linear, Notion',
        createdAt: '2026-11-09T10:30:00.000Z',
      },
    ];

    const plans = planSearchQueries(
      'Compare pricing and updates for HubSpot, Salesforce, Pipedrive, Zoho, Close, Linear',
      memoryMessages,
      undefined,
      { maxQueries: 4 }
    );

    expect(plans).toHaveLength(4);
    expect(plans.isComplete).toBe(false);
    expect(plans.unsearchedEntities.length).toBeGreaterThan(0);
    expect(plans.coverageNote).toContain('Search budget reached');
    expect(plans.coverageNote).toContain('Not checked within budget');
  });

  it('should not emit example.com as authentic web evidence for unscripted mock queries', async () => {
    const provider = new MockSearchProvider();
    const results = await provider.search('unknown esoteric query xyz 123');

    expect(results).toHaveLength(1);
    expect(results[0].url).not.toContain('example.com');
    expect(results[0].url).toContain('offline-mode');
    expect(results[0].snippet).toContain('[Offline Mock Mode Active]');
  });
});
