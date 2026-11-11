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

const GENERIC_TERMS = new Set([
  'crm',
  'tool',
  'tools',
  'app',
  'apps',
  'software',
  'platform',
  'database',
  'db',
  'hosting',
  'service',
  'services',
  'sales',
  'sales team',
  'shortlist',
  'shortlisted',
  'shortlisted 5',
  'team',
  'option',
  'options',
  'plan',
  'plans',
  'pricing',
  'price',
]);

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
    if (unquoted.length > 1 && !GENERIC_TERMS.has(unquoted.toLowerCase())) {
      userMatched.add(unquoted.toLowerCase());
    }
  }

  // 2. Known entity substrings
  for (const entity of KNOWN_ENTITIES) {
    const regex = new RegExp(`\\b${escapeRegex(entity)}\\b`, 'i');
    if (regex.test(userQuery)) {
      if (entity === 'close crm') {
        userMatched.add('close');
      } else if (entity === 'postgresql') {
        userMatched.add('postgres');
      } else {
        userMatched.add(entity);
      }
    }
  }

  // 3. Multi-word tool/software patterns: e.g. "Linear app", "Cursor IDE", "Raycast Pro"
  // Note: Case-sensitive for leading capitalized letters so words like "shortlisted" are not matched
  const appPhraseMatch = userQuery.match(
    /\b([A-Z][a-zA-Z0-9_.-]+(?:\s+[A-Z][a-zA-Z0-9_.-]+)?)\s+(?:app|tool|software|crm|platform|database|db|hosting|service)\b/
  );
  if (appPhraseMatch && appPhraseMatch[1]) {
    const term = appPhraseMatch[1].toLowerCase();
    if (!GENERIC_TERMS.has(term)) {
      userMatched.add(term);
    }
  }

  // 4. Capitalized noun phrases (excluding query boilerplate words)
  const capitalizedTerms = userQuery.match(/\b[A-Z][a-zA-Z0-9_.-]+\b/g) || [];
  for (const term of capitalizedTerms) {
    const lowerTerm = term.toLowerCase();
    if (
      !GENERIC_TERMS.has(lowerTerm) &&
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

  // Filter out any lingering generic terms
  const filteredUser = Array.from(userMatched).filter(e => !GENERIC_TERMS.has(e.toLowerCase()));

  // If user query specifically mentions entities, prioritize them exclusively
  if (filteredUser.length > 0) {
    return filteredUser;
  }

  // 5. Fallback: If user query references past context (e.g. "Has any of them changed?"), pull entities from memory
  const memoryMatched = new Set<string>();
  for (const msg of memoryMessages) {
    for (const entity of KNOWN_ENTITIES) {
      const regex = new RegExp(`\\b${escapeRegex(entity)}\\b`, 'i');
      if (regex.test(msg.content)) {
        // Standardize overlapping entity terms to avoid duplicate entity counting
        if (entity === 'close crm') {
          memoryMatched.add('close');
        } else if (entity === 'postgresql') {
          memoryMatched.add('postgres');
        } else {
          memoryMatched.add(entity);
        }
      }
    }
  }

  return Array.from(memoryMatched);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SearchPlanningResult extends Array<SearchQueryPlan> {
  searchedEntities: string[];
  unsearchedEntities: string[];
  isComplete: boolean;
  coverageNote?: string;
}

/**
 * Generates targeted search queries with fair entity and intent allocation
 */
export function planSearchQueries(
  userQuery: string,
  memoryMessages: Message[] = [],
  temporal?: TemporalResolution,
  options: PlanAndExecuteOptions = {}
): SearchPlanningResult {
  const maxQueries = options.maxQueries ?? 5;
  const plans: SearchQueryPlan[] = [];
  const lowerQuery = userQuery.toLowerCase();

  const isPricingIntent = /pricing|price|cost|tier|plan|bill|expensive|cheap|\$/i.test(lowerQuery);
  const isChangelogIntent =
    /shipped|release|update|change|new feature|changelog|announcement/i.test(lowerQuery);

  const entities = extractTargetEntities(userQuery, memoryMessages);

  // Timeframe hint
  const timeframe = temporal ? `since ${temporal.expression}` : `${new Date().getFullYear()}`;

  const searchedEntitiesSet = new Set<string>();

  if (entities.length > 0) {
    // Fair allocation: Round-robin across entities so every entity receives search coverage
    // Pass 1: Ensure each entity receives at least 1 primary targeted query
    let entityIdx = 0;
    for (const entity of entities) {
      if (plans.length >= maxQueries) break;
      searchedEntitiesSet.add(entity);

      if (isPricingIntent && isChangelogIntent) {
        const category: SearchCategory = entityIdx % 2 === 0 ? 'pricing' : 'changelog';
        plans.push({
          query: `${entity} pricing updates release notes ${timeframe}`.trim(),
          category,
          targetEntity: entity,
          intent: `Verify recent pricing changes and release updates for ${entity}`,
          timeframeHint: timeframe,
        });
        entityIdx++;
      } else if (isPricingIntent) {
        plans.push({
          query: `${entity} official pricing plans tiers ${timeframe}`.trim(),
          category: 'pricing',
          targetEntity: entity,
          intent: `Verify official current pricing and plans for ${entity}`,
          timeframeHint: timeframe,
        });
      } else if (isChangelogIntent) {
        plans.push({
          query: `${entity} changelog release notes updates ${timeframe}`.trim(),
          category: 'changelog',
          targetEntity: entity,
          intent: `Check official release notes and changelog for ${entity}`,
          timeframeHint: timeframe,
        });
      } else {
        plans.push({
          query: `${entity} official documentation updates ${timeframe}`.trim(),
          category: 'general',
          targetEntity: entity,
          intent: `General search for ${entity}`,
        });
      }
    }

    // Pass 2: If budget remains, add dedicated changelog queries
    if (isChangelogIntent && plans.length < maxQueries) {
      for (const entity of entities) {
        if (plans.length >= maxQueries) break;
        plans.push({
          query: `${entity} changelog release notes ${timeframe}`.trim(),
          category: 'changelog',
          targetEntity: entity,
          intent: `Check dedicated changelog for ${entity}`,
          timeframeHint: timeframe,
        });
      }
    }

    // Pass 3: If budget remains and pricing was requested, add dedicated pricing changes queries
    if (isPricingIntent && plans.length < maxQueries) {
      for (const entity of entities) {
        if (plans.length >= maxQueries) break;
        plans.push({
          query: `${entity} pricing changes ${timeframe}`.trim(),
          category: 'pricing',
          targetEntity: entity,
          intent: `Check dedicated pricing changes for ${entity}`,
          timeframeHint: timeframe,
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
      if (plans.length < maxQueries) {
        plans.push({
          query: `${cleanedPrompt} pricing changes updates`.trim(),
          category: 'pricing',
          intent: 'Search pricing changes',
        });
      }
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

  // Deduplicate search plans by normalized query string
  const uniquePlans: SearchQueryPlan[] = [];
  const seenQueries = new Set<string>();

  for (const plan of plans) {
    const normalized = plan.query.trim().toLowerCase();
    if (!seenQueries.has(normalized)) {
      seenQueries.add(normalized);
      uniquePlans.push(plan);
    }
  }

  const finalPlans = uniquePlans.slice(0, maxQueries);
  const searchedEntities = Array.from(searchedEntitiesSet);
  const unsearchedEntities = entities.filter(e => !searchedEntitiesSet.has(e));
  const isComplete = unsearchedEntities.length === 0;

  let coverageNote: string | undefined;
  if (!isComplete) {
    coverageNote = `Search budget reached (${maxQueries} queries). Checked: ${searchedEntities.join(
      ', '
    )}. Not checked within budget: ${unsearchedEntities.join(', ')}.`;
  }

  const result = Object.assign([...finalPlans], {
    searchedEntities,
    unsearchedEntities,
    isComplete,
    coverageNote,
  });

  return result as SearchPlanningResult;
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
