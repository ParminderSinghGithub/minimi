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
  'linear',
  'notion',
  'slack',
  'stripe',
  'figma',
  'jira',
  'datadog',
  'clickup',
  'monday.com',
  'raycast',
];

/**
 * Extracts entities mentioned in user query or prior messages.
 * Recognizes multi-word tools, quoted terms, and software/app phrases dynamically.
 */
export function extractTargetEntities(userQuery: string, memoryMessages: Message[] = []): string[] {
  const userMatched = new Set<string>();

  // 1. Quoted terms: "Linear app", "Monday.com"
  const quotedMatches = userQuery.match(/["']([^"']+)["']/g) || [];
  for (const q of quotedMatches) {
    const unquoted = q.slice(1, -1).trim();
    if (unquoted.length > 1) {
      userMatched.add(unquoted.toLowerCase());
    }
  }

  // 2. Known entity substrings
  for (const entity of KNOWN_ENTITIES) {
    const regex = new RegExp(`\\b${escapeRegex(entity)}\\b`, 'i');
    if (regex.test(userQuery)) {
      userMatched.add(entity);
    }
  }

  // 3. Multi-word tool/software patterns: e.g. "Linear app", "Cursor IDE", "Raycast Pro"
  const appPhraseMatch = userQuery.match(/\b([A-Z][a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)?)\s+(?:app|tool|software|crm|platform|database|db|hosting|service)\b/i);
  if (appPhraseMatch && appPhraseMatch[1]) {
    userMatched.add(appPhraseMatch[1].toLowerCase());
  }

  // 4. Capitalized noun phrases (excluding query boilerplate words)
  const capitalizedTerms = userQuery.match(/\b[A-Z][a-zA-Z0-9_.-]+\b/g) || [];
  for (const term of capitalizedTerms) {
    const lowerTerm = term.toLowerCase();
    if (
      ![
        'what',
        'when',
        'where',
        'which',
        'who',
        'how',
        'is',
        'are',
        'has',
        'did',
        'on',
        'last',
        'this',
        'can',
        'could',
        'show',
        'tell',
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december',
      ].includes(lowerTerm)
    ) {
      userMatched.add(lowerTerm);
    }
  }

  // If user query specifically mentions entities, prioritize them exclusively
  if (userMatched.size > 0) {
    return Array.from(userMatched);
  }

  // 5. Fallback: If user query references past context (e.g. "Has any of them changed?"), pull entities from memory
  const memoryMatched = new Set<string>();
  for (const msg of memoryMessages) {
    for (const entity of KNOWN_ENTITIES) {
      const regex = new RegExp(`\\b${escapeRegex(entity)}\\b`, 'i');
      if (regex.test(msg.content)) {
        memoryMatched.add(entity);
      }
    }
  }

  return Array.from(memoryMatched);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates targeted search queries with intent-specific query allocation
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
  const isChangelogIntent =
    /shipped|release|update|change|new feature|changelog|announcement/i.test(lowerQuery);

  const entities = extractTargetEntities(userQuery, memoryMessages);

  // Timeframe hint
  const timeframe = temporal ? `since ${temporal.expression}` : `${new Date().getFullYear()}`;

  if (entities.length > 0) {
    for (const entity of entities) {
      if (plans.length >= maxQueries) break;

      // Intent-specific query allocation
      if (isPricingIntent) {
        plans.push({
          query: `${entity} official pricing plans tiers ${timeframe}`.trim(),
          category: 'pricing',
          targetEntity: entity,
          intent: `Verify official current pricing and plans for ${entity}`,
          timeframeHint: timeframe,
        });

        if (plans.length < maxQueries) {
          plans.push({
            query: `${entity} pricing changes ${timeframe}`.trim(),
            category: 'pricing',
            targetEntity: entity,
            intent: `Check for recent pricing updates for ${entity}`,
            timeframeHint: timeframe,
          });
        }
      }

      if (isChangelogIntent && plans.length < maxQueries) {
        plans.push({
          query: `${entity} changelog release notes updates ${timeframe}`.trim(),
          category: 'changelog',
          targetEntity: entity,
          intent: `Check official release notes and changelog for ${entity}`,
          timeframeHint: timeframe,
        });
      }

      // If neither pricing nor changelog was explicitly flagged, provide balanced queries
      if (!isPricingIntent && !isChangelogIntent) {
        plans.push({
          query: `${entity} official documentation updates ${timeframe}`.trim(),
          category: 'general',
          targetEntity: entity,
          intent: `General search for ${entity}`,
        });
      }
    }
  } else {
    // Unfamiliar query without detected entity: clean prompt boilerplate
    const cleanedPrompt = userQuery
      .replace(
        /\b(?:what is the current pricing for|can you compare|has any pricing changed for|tell me about|what are)\b/gi,
        ''
      )
      .trim();

    if (isPricingIntent) {
      plans.push({
        query: `${cleanedPrompt} official pricing plans`.trim(),
        category: 'pricing',
        intent: 'Search official pricing details',
      });
      plans.push({
        query: `${cleanedPrompt} pricing changes updates`.trim(),
        category: 'pricing',
        intent: 'Search pricing changes',
      });
    }

    if (isChangelogIntent && plans.length < maxQueries) {
      plans.push({
        query: `${cleanedPrompt} changelog release notes`.trim(),
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
