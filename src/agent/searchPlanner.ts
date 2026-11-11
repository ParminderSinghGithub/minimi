import type {
  SearchCategory,
  SearchQueryPlan,
  SearchResultItem,
  Citation,
  Message,
  TemporalResolution,
} from '../types/index.js';
import { type WebSearchProvider, buildCitations } from '../tools/search.js';

export interface PlanAndExecuteOptions {
  maxQueries?: number;
  maxResultsPerQuery?: number;
}

export interface SearchExecutionResult {
  plans: SearchQueryPlan[];
  rawResults: SearchResultItem[];
  citations: Citation[];
  failedQueries: Array<{ query: string; error: string }>;
}

const KNOWN_ENTITIES = [
  'hubspot',
  'salesforce',
  'pipedrive',
  'zoho',
  'close crm',
  'close',
  'supabase',
  'neon',
  'aws rds',
  'aws aurora',
  'aurora serverless',
  'postgres',
  'postgresql',
];

/**
 * Extracts entities mentioned in past messages or user query
 */
export function extractTargetEntities(userQuery: string, memoryMessages: Message[] = []): string[] {
  const combinedText = [
    userQuery,
    ...memoryMessages.map(m => m.content),
  ].join(' ').toLowerCase();

  const matched = new Set<string>();

  for (const entity of KNOWN_ENTITIES) {
    const regex = new RegExp(`\\b${entity}\\b`, 'i');
    if (regex.test(combinedText)) {
      matched.add(entity);
    }
  }

  // Also check for capitalized noun phrases if no known entities match
  if (matched.size === 0) {
    const capitalizedTerms = userQuery.match(/\b[A-Z][a-zA-Z0-9_-]+\b/g) || [];
    for (const term of capitalizedTerms) {
      if (!['What', 'When', 'Where', 'Which', 'Who', 'How', 'Is', 'Are', 'Has', 'Did', 'On', 'Last', 'This'].includes(term)) {
        matched.add(term.toLowerCase());
      }
    }
  }

  return Array.from(matched);
}

/**
 * Generates multiple targeted search queries prioritizing pricing, changelogs, and release notes
 */
export function planSearchQueries(
  userQuery: string,
  memoryMessages: Message[] = [],
  temporal?: TemporalResolution,
  options: PlanAndExecuteOptions = {}
): SearchQueryPlan[] {
  const maxQueries = options.maxQueries ?? 5;
  const plans: SearchQueryPlan[] = [];
  const lowerQuery = userQuery.toLowerCase();

  const isPricingIntent = /pricing|price|cost|tier|plan|bill|expensive|cheap/i.test(lowerQuery);
  const isChangelogIntent = /shipped|release|update|change|new feature|changelog|announcement/i.test(lowerQuery);

  const entities = extractTargetEntities(userQuery, memoryMessages);

  // Derive timeframe hint from temporal or current year
  const timeframe = temporal ? `since ${temporal.expression}` : `${new Date().getFullYear()}`;

  if (entities.length > 0) {
    for (const entity of entities) {
      if (plans.length >= maxQueries) break;

      // Prioritize pricing query if requested or contextually relevant
      if (isPricingIntent || !isChangelogIntent) {
        plans.push({
          query: `${entity} pricing ${timeframe}`.trim(),
          category: 'pricing',
          targetEntity: entity,
          intent: `Verify official current pricing and changes for ${entity}`,
          timeframeHint: timeframe,
        });
      }

      // Prioritize changelog / release notes query
      if ((isChangelogIntent || isPricingIntent) && plans.length < maxQueries) {
        plans.push({
          query: `${entity} changelog release notes updates ${timeframe}`.trim(),
          category: 'changelog',
          targetEntity: entity,
          intent: `Check latest product updates and release notes for ${entity}`,
          timeframeHint: timeframe,
        });
      }
    }
  } else {
    // General query decomposition if no distinct entities found
    if (isPricingIntent) {
      plans.push({
        query: `${userQuery} pricing official`.trim(),
        category: 'pricing',
        intent: 'Search official pricing details',
      });
    }

    if (isChangelogIntent) {
      plans.push({
        query: `${userQuery} changelog release notes`.trim(),
        category: 'changelog',
        intent: 'Search changelog and release notes',
      });
    }

    if (plans.length === 0) {
      plans.push({
        query: userQuery,
        category: 'general',
        intent: 'General factual web search',
      });
    }
  }

  return plans.slice(0, maxQueries);
}

/**
 * Executes multi-target search plans with concurrency control and graceful error recovery
 */
export async function executeSearchPlans(
  searchProvider: WebSearchProvider,
  plans: SearchQueryPlan[],
  options: PlanAndExecuteOptions = {}
): Promise<SearchExecutionResult> {
  const maxResultsPerQuery = options.maxResultsPerQuery ?? 3;
  const allResults: SearchResultItem[] = [];
  const failedQueries: Array<{ query: string; error: string }> = [];

  // Run targeted queries concurrently
  const searchPromises = plans.map(async plan => {
    try {
      const results = await searchProvider.search(plan.query, {
        maxResults: maxResultsPerQuery,
        category: plan.category,
      });
      return { plan, results, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { plan, results: [], error: message };
    }
  });

  const settled = await Promise.all(searchPromises);

  for (const item of settled) {
    if (item.error) {
      failedQueries.push({ query: item.plan.query, error: item.error });
    } else {
      for (const res of item.results) {
        allResults.push({
          ...res,
          category: item.plan.category,
        });
      }
    }
  }

  // Deduplicate and build citations preserving URLs and publication dates
  const citations = buildCitations(allResults);

  return {
    plans,
    rawResults: allResults,
    citations,
    failedQueries,
  };
}
