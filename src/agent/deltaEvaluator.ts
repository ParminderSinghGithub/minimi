import type {
  EvidenceStatus,
  DeltaComparison,
  Citation,
  Message,
  SearchResultItem,
  TemporalResolution,
} from '../types/index.js';

export interface DeltaEvaluationInput {
  userQuery: string;
  historicalMessages: Message[];
  searchResults: SearchResultItem[];
  citations: Citation[];
  temporal?: TemporalResolution;
}

/**
 * Normalizes and extracts pricing figures (e.g. $25/month, $100/seat/month, $49.90)
 */
function extractPricingFigures(text: string): string[] {
  const matches = text.match(/\$\d+(?:\.\d{2})?(?:\/(?:month|mo|seat|user|year|yr))?/gi) || [];
  return Array.from(new Set(matches.map(m => m.toLowerCase().replace('/mo', '/month'))));
}

/**
 * Evaluates whether historical claims from conversation memory match current web evidence
 */
export function evaluateDelta(input: DeltaEvaluationInput): DeltaComparison | undefined {
  const { userQuery, historicalMessages, searchResults, citations, temporal } = input;

  if (historicalMessages.length === 0) {
    return undefined;
  }

  // Only evaluate delta if the user's query asks about historical continuity or changes over time
  const isDeltaIntent =
    /changed|change|changes|pricing changed|shipped|still correct|still valid|since then|since|updates? since|differ/i.test(
      userQuery
    ) || Boolean(temporal);

  if (!isDeltaIntent) {
    return undefined;
  }

  // Find the primary assistant message containing historical factual claims
  const historicalAssistantMsg = [...historicalMessages]
    .reverse()
    .find(m => m.role === 'assistant');

  if (!historicalAssistantMsg) {
    return undefined;
  }

  const historicalText = historicalAssistantMsg.content;
  const historicalDate = temporal?.startDate || historicalAssistantMsg.createdAt;
  const historicalPricing = extractPricingFigures(historicalText);

  // Combine search snippet evidence
  const searchEvidenceText = searchResults.map(r => `${r.title}: ${r.snippet}`).join('\n');
  const currentPricing = extractPricingFigures(searchEvidenceText);

  let status: EvidenceStatus = 'INCONCLUSIVE_NO_EVIDENCE';
  let reasoning = '';
  let currentClaimSummary = '';

  // Rule 1: Absence of search results or evidence is NEVER treated as proof that nothing changed
  if (searchResults.length === 0 || citations.length === 0) {
    status = 'INCONCLUSIVE_NO_EVIDENCE';
    reasoning =
      'No web search evidence was retrieved. Absence of search results cannot be treated as confirmation that pricing or features remained unchanged.';
    currentClaimSummary = 'Current state could not be verified due to lack of web search results.';
  } else {
    // Check for explicit updates / changelogs
    const hasChangelogEvidence = searchResults.some(r =>
      /changelog|release|shipped|introduced|announced|new feature/i.test(r.title + ' ' + r.snippet)
    );

    // Check pricing match or drift
    if (historicalPricing.length > 0 && currentPricing.length > 0) {
      const confirmedPrices = historicalPricing.filter(hp => currentPricing.includes(hp));
      const novelPrices = currentPricing.filter(cp => !historicalPricing.includes(cp));

      // Check if text explicitly says "now $X", "price increase", "new pricing"
      const explicitPriceChangeMention = /price increase|pricing increase|increased to|now \$|raised pricing|changed pricing/i.test(
        searchEvidenceText
      );

      if (explicitPriceChangeMention || (novelPrices.length > 0 && confirmedPrices.length === 0)) {
        status = 'VERIFIED_CHANGE';
        reasoning = `Evidence indicates pricing changes: detected new or altered pricing (${novelPrices.join(', ')}).`;
        currentClaimSummary = `Current pricing references observed in search: ${currentPricing.join(', ')}.`;
      } else if (confirmedPrices.length > 0) {
        if (hasChangelogEvidence) {
          status = 'VERIFIED_CHANGE';
          reasoning = `Base pricing (${confirmedPrices.join(', ')}) is verified unchanged, but new product features/updates have shipped recently according to release notes.`;
          currentClaimSummary = `Pricing confirmed at ${confirmedPrices.join(', ')}, with new product updates noted in changelogs.`;
        } else {
          status = 'CONFIRMED_UNCHANGED';
          reasoning = `Official pricing sources actively confirm historical pricing (${confirmedPrices.join(', ')}). No conflicting changes detected.`;
          currentClaimSummary = `Verified active pricing matches historical record: ${confirmedPrices.join(', ')}.`;
        }
      } else {
        status = 'INCONCLUSIVE_NO_EVIDENCE';
        reasoning =
          'Recent search snippets did not contain definitive matching pricing figures for direct comparison. Absence of explicit pricing does not confirm that pricing remained unchanged.';
        currentClaimSummary = 'Inconclusive: No direct price match found in current snippets.';
      }
    } else if (hasChangelogEvidence) {
      status = 'VERIFIED_CHANGE';
      reasoning = 'Release notes and changelogs confirm recent product updates or new features shipped.';
      currentClaimSummary = 'Recent feature releases and changelog updates identified.';
    } else {
      status = 'INCONCLUSIVE_NO_EVIDENCE';
      reasoning =
        'Insufficient specific evidence found in search results to verify or contradict the historical claims. Missing evidence is not proof that nothing changed.';
      currentClaimSummary = 'Inconclusive: Not enough evidence found in search results.';
    }
  }

  // Determine entity or topic
  const entityMatch = historicalText.match(/\b(HubSpot|Salesforce|Pipedrive|Zoho|Close|Supabase|Neon|Postgres)\b/i);
  const entityOrTopic = entityMatch ? entityMatch[0] : 'Historical Topic';

  return {
    entityOrTopic,
    historicalState: {
      date: historicalDate,
      claim: historicalText.slice(0, 300) + (historicalText.length > 300 ? '...' : ''),
      sourceMessageId: historicalAssistantMsg.id,
    },
    currentState: {
      claim: currentClaimSummary,
      evidenceUrls: citations.map(c => c.url),
    },
    status,
    explanation: reasoning,
    citations,
  };
}
