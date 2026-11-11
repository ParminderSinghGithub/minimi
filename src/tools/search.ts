import type { SearchCategory, SearchResultItem, Citation } from '../types/index.js';

export interface SearchOptions {
  maxResults?: number;
  category?: SearchCategory;
  includeDomains?: string[];
  days?: number;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResultItem[]>;
}

/**
 * Tavily Web Search Provider implementation
 * Uses Tavily's REST API specifically designed for AI agents
 */
export class TavilySearchProvider implements WebSearchProvider {
  readonly name = 'tavily';
  private apiKey: string;
  private timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number = 8000) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResultItem[]> {
    if (!query || query.trim() === '') {
      return [];
    }

    if (!this.apiKey) {
      throw new Error('TAVILY_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: 'advanced',
          max_results: options?.maxResults ?? 5,
          include_domains: options?.includeDomains,
          days: options?.days,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Tavily API returned status ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        results?: Array<{
          title: string;
          url: string;
          content: string;
          published_date?: string;
          score?: number;
        }>;
      };

      const results: SearchResultItem[] = (data.results || []).map((item, index) => ({
        id: `tavily-${Date.now()}-${index}`,
        title: item.title || 'Untitled Source',
        url: item.url,
        snippet: item.content || '',
        publishedDate: item.published_date,
        category: options?.category || 'general',
        retrievedAt: new Date().toISOString(),
        isMock: false,
      }));

      return results;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Tavily search timed out after ${this.timeoutMs}ms for query: "${query}"`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Mock Search Provider for offline hermetic testing and deterministic evaluation
 */
export class MockSearchProvider implements WebSearchProvider {
  readonly name = 'mock';
  private customMockData: Map<string, SearchResultItem[]> = new Map();
  private failNextSearch: boolean = false;

  setMockResponse(querySubstring: string, results: SearchResultItem[]): void {
    this.customMockData.set(
      querySubstring.toLowerCase(),
      results.map(r => ({ ...r, isMock: true }))
    );
  }

  setShouldFail(fail: boolean): void {
    this.failNextSearch = fail;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResultItem[]> {
    if (!query || query.trim() === '') {
      return [];
    }

    if (this.failNextSearch) {
      this.failNextSearch = false;
      throw new Error(`Simulated search failure for query: "${query}"`);
    }

    const lowerQuery = query.toLowerCase();

    // Check custom mock entries
    for (const [key, results] of this.customMockData.entries()) {
      if (lowerQuery.includes(key)) {
        return results;
      }
    }

    // Default realistic mock data for challenge scenarios (marked with isMock: true)
    if (lowerQuery.includes('supabase') && lowerQuery.includes('pricing')) {
      return [
        {
          id: 'mock-sb-1',
          title: 'Supabase Pricing & Compute Updates',
          url: 'https://supabase.com/pricing',
          snippet:
            'Supabase Pro remains at $25/month including $10 compute credits. In late 2024, compute pricing introduced fractional add-ons.',
          publishedDate: '2026-11-05',
          category: 'pricing',
          retrievedAt: new Date().toISOString(),
          isMock: true,
        },
        {
          id: 'mock-sb-2',
          title: 'Supabase Changelog - November 2026',
          url: 'https://supabase.com/changelog',
          snippet:
            'Shipped support for Postgres 17 in early access, enhanced vector indexing performance by 3x.',
          publishedDate: '2026-11-08',
          category: 'changelog',
          retrievedAt: new Date().toISOString(),
          isMock: true,
        },
      ];
    }

    if (lowerQuery.includes('neon') && lowerQuery.includes('pricing')) {
      return [
        {
          id: 'mock-neon-1',
          title: 'Neon Serverless Postgres Pricing',
          url: 'https://neon.tech/pricing',
          snippet:
            'Neon Launch plan remains $19/mo. Scale plan at $69/mo. Compute unit billing unchanged at $0.16/CU-hr.',
          publishedDate: '2026-11-04',
          category: 'pricing',
          retrievedAt: new Date().toISOString(),
          isMock: true,
        },
      ];
    }

    if (
      lowerQuery.includes('hubspot') &&
      (lowerQuery.includes('pricing') || lowerQuery.includes('crm') || lowerQuery.includes('changelog'))
    ) {
      return [
        {
          id: 'mock-hs-1',
          title: 'HubSpot Sales Hub Pricing & Packaging',
          url: 'https://www.hubspot.com/pricing/sales',
          snippet:
            'HubSpot Sales Hub Pro is $100/seat/month. HubSpot recently introduced Breeze AI copilot features across all Pro tiers at no extra charge.',
          publishedDate: '2026-11-08',
          category: 'pricing',
          retrievedAt: new Date().toISOString(),
          isMock: true,
        },
      ];
    }

    if (lowerQuery.includes('salesforce') && lowerQuery.includes('pricing')) {
      return [
        {
          id: 'mock-sf-1',
          title: 'Salesforce Sales Cloud Pricing',
          url: 'https://www.salesforce.com/editions-pricing/sales-cloud/',
          snippet:
            'Sales Cloud Enterprise is $165/user/month billed annually. Agentforce service add-on launched in October.',
          publishedDate: '2026-11-01',
          category: 'pricing',
          retrievedAt: new Date().toISOString(),
          isMock: true,
        },
      ];
    }

    // In offline mock mode, unscripted queries return a clear, honest mock diagnostic indicator
    // rather than disguising example.com as genuine web evidence
    return [
      {
        id: `mock-offline-${Date.now()}`,
        title: `No offline simulation entry for "${query}"`,
        url: `https://minimi.local/offline-mode?query=${encodeURIComponent(query)}`,
        snippet:
          `[Offline Mock Mode Active] No live search credentials configured (TAVILY_API_KEY). Real web search was not performed for this query.`,
        publishedDate: new Date().toISOString().slice(0, 10),
        category: options?.category || 'general',
        retrievedAt: new Date().toISOString(),
        isMock: true,
      },
    ];
  }
}

/**
 * Factory to create search provider based on environment and options
 */
export function createSearchProvider(
  preferredProvider?: string,
  apiKey?: string
): WebSearchProvider {
  const provider = preferredProvider || process.env.SEARCH_PROVIDER || 'tavily';
  const key = apiKey || process.env.TAVILY_API_KEY;

  if (provider === 'mock' || !key || key.startsWith('your_')) {
    return new MockSearchProvider();
  }

  return new TavilySearchProvider(key);
}

/**
 * Normalizes URL strings by resolving hostnames and stripping trailing slashes.
 */
function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return rawUrl.trim().replace(/\/+$/, '');
  }
}

/**
 * Transforms search results into ordered, deduplicated citations.
 * Clearly marks simulated/mock citations so reviewers know when offline mode is active.
 */
export function buildCitations(results: SearchResultItem[]): Citation[] {
  const seenUrls = new Set<string>();
  const citations: Citation[] = [];

  for (const item of results) {
    if (!item.url) continue;
    const normalized = normalizeUrl(item.url);
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);

    const isMock = Boolean(item.isMock);
    const displayTitle = isMock && !item.title.startsWith('[Demo Simulation]')
      ? `[Demo Simulation] ${item.title}`
      : item.title;

    citations.push({
      id: citations.length + 1,
      title: displayTitle,
      url: item.url,
      snippet: item.snippet,
      publishedDate: item.publishedDate,
      isMock,
    });
  }

  return citations;
}
