import { describe, it, expect } from 'vitest';
import type { Message, TemporalResolution, SearchQueryPlan, DeltaComparison } from './index.js';

describe('Domain Contracts', () => {
  it('should construct a valid Message object with ISO timestamp', () => {
    const msg: Message = {
      id: 'msg-1',
      sessionId: 'session-1',
      role: 'user',
      content: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
      createdAt: '2026-11-09T10:00:00.000Z',
    };
    expect(msg.id).toBe('msg-1');
    expect(msg.role).toBe('user');
    expect(Date.parse(msg.createdAt)).toBeGreaterThan(0);
  });

  it('should represent a valid TemporalResolution contract', () => {
    const resolution: TemporalResolution = {
      expression: 'last Tuesday',
      startDate: '2026-11-03T00:00:00.000Z',
      endDate: '2026-11-03T23:59:59.999Z',
      isRange: true,
      confidence: 0.95,
      referenceTimestamp: '2026-11-11T12:00:00.000Z',
      timezone: 'Asia/Kolkata',
    };
    expect(resolution.isRange).toBe(true);
    expect(resolution.confidence).toBeGreaterThan(0.5);
  });

  it('should categorize targeted search queries', () => {
    const plan: SearchQueryPlan = {
      query: 'HubSpot sales CRM pricing changes November 2026',
      category: 'pricing',
      targetEntity: 'HubSpot',
      intent: 'Verify if pricing or packaging has changed since Monday',
    };
    expect(plan.category).toBe('pricing');
    expect(plan.targetEntity).toBe('HubSpot');
  });

  it('should support DeltaComparison with strict evidence statuses', () => {
    const delta: DeltaComparison = {
      entityOrTopic: 'Postgres Hosting',
      historicalState: {
        date: '2026-11-03T10:00:00.000Z',
        claim: 'Supabase Pro was $25/mo and Neon Pro was $19/mo',
      },
      currentState: {
        claim: 'Supabase pricing remains $25/mo; no pricing updates detected.',
        evidenceUrls: ['https://supabase.com/pricing'],
      },
      status: 'CONFIRMED_UNCHANGED',
      explanation: 'Official pricing page verified active matching historical claim.',
      citations: [
        {
          id: 1,
          title: 'Supabase Pricing',
          url: 'https://supabase.com/pricing',
          snippet: 'Pro plan starts at $25/month.',
        },
      ],
    };
    expect(delta.status).toBe('CONFIRMED_UNCHANGED');
    expect(delta.citations).toHaveLength(1);
  });
});
