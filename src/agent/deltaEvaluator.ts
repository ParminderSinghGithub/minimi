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
  return Array.from(new Set(matches.map(m => m.toLowerCase().replace(/\/mo\b/gi, '/month'))));
}

/**
 * Evaluates whether historical claims from conversation memory match current web evidence.
 * Requires dated evidence or official domain confirmation before declaring CONFIRMED_UNCHANGED.
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
  const isMockEvidence = searchResults.some(r => r.isMock);
  const searchEvidenceText = searchResults.map(r => `${r.title}: ${r.snippet}`).join('\n');
  const currentPricing = extractPricingFigures(searchEvidenceText);

  let status: EvidenceStatus = 'INCONCLUSIVE_NO_EVIDENCE';
  let reasoning = '';
  let currentClaimSummary = '';

  // Rule 1: Mock/simulated search results can NEVER produce a live VERIFIED_CHANGE or CONFIRMED_UNCHANGED verdict
  if (isMockEvidence) {
    status = 'DEMO_SIMULATION';
    reasoning =
      '[Demo Simulation Active] Evaluated using offline mock fixtures. Simulated citations and results do not constitute live web evidence.';
    currentClaimSummary = `[Demo Simulation] Simulated pricing and release references: ${
      currentPricing.length > 0 ? currentPricing.join(', ') : 'Demo fixtures checked'
    }.`;
  } else if (searchResults.length === 0 || citations.length === 0) {
    // Rule 2: Absence of search results or evidence is NEVER treated as proof that nothing changed
    status = 'INCONCLUSIVE_NO_EVIDENCE';
    reasoning =
      'No web search evidence was retrieved. Absence of search results cannot be treated as confirmation that pricing or features remained unchanged.';
    currentClaimSummary = 'Current state could not be verified due to lack of web search results.';
  } else {
    // Determine history reference timestamp ms for comparison window
    const historyStartMs = temporal?.startDate ? Date.parse(temporal.startDate) : Date.parse(historicalAssistantMsg.createdAt);

    // Check for explicit updates / changelogs supported by dated evidence
    const hasDatedChangelogEvidence = searchResults.some(r => {
      const isChangelog = /changelog|release|shipped|introduced|announced|new feature/i.test(r.title + ' ' + r.snippet);
      if (!isChangelog) return false;
      if (!r.publishedDate) return true;
      const pubMs = Date.parse(r.publishedDate);
      return isNaN(pubMs) || isNaN(historyStartMs) || pubMs >= historyStartMs - 86400000;
    });

    // Check pricing match or drift
    if (historicalPricing.length > 0 && currentPricing.length > 0) {
      const confirmedPrices = historicalPricing.filter(hp => currentPricing.includes(hp));
      const novelPrices = currentPricing.filter(cp => !historicalPricing.includes(cp));

      // Check if text explicitly indicates price change
      const explicitPriceChangeMention =
        /price increase|pricing increase|increased to|now \$|raised pricing|changed pricing/i.test(
          searchEvidenceText
        );

      if (explicitPriceChangeMention || (novelPrices.length > 0 && confirmedPrices.length === 0)) {
        status = 'VERIFIED_CHANGE';
        reasoning = `Live web evidence indicates pricing changes: detected new or altered pricing (${novelPrices.join(', ')}).`;
        currentClaimSummary = `Current pricing references observed in search: ${currentPricing.join(', ')}.`;
      } else if (confirmedPrices.length > 0) {
        // Enforce dated evidence requirement covering the requested interval
        // A current price on an official website does NOT, by itself, prove the price remained unchanged throughout the interval
        const hasIntervalSpanningEvidence = searchResults.some(r => {
          if (!r.publishedDate) return false;
          const pubMs = Date.parse(r.publishedDate);
          return !isNaN(pubMs) && !isNaN(historyStartMs) && pubMs >= historyStartMs;
        });

        if (hasDatedChangelogEvidence) {
          status = 'VERIFIED_CHANGE';
          reasoning = `Base pricing (${confirmedPrices.join(', ')}) matches historical claims, but verified product releases or updates have shipped since according to release notes.`;
          currentClaimSummary = `Pricing matches at ${confirmedPrices.join(', ')}, with new product updates noted in changelogs.`;
        } else if (hasIntervalSpanningEvidence) {
          status = 'CONFIRMED_UNCHANGED';
          reasoning = `Dated sources actively confirm historical pricing (${confirmedPrices.join(', ')}) with timestamps covering the requested evaluation window. No conflicting price changes detected.`;
          currentClaimSummary = `Verified active pricing matches historical record: ${confirmedPrices.join(', ')}.`;
        } else {
          // A matching price string on an official website or undated snippet alone is NOT proof of non-change throughout the interval
          status = 'INCONCLUSIVE_NO_EVIDENCE';
          reasoning = `Matching price figure (${confirmedPrices.join(', ')}) was observed, but search snippets lack interval-spanning dated confirmation or changelog proving pricing remained unchanged throughout the requested period. A current price alone cannot establish that pricing remained unchanged over the entire interval.`;
          currentClaimSummary = `Inconclusive: Observed price (${confirmedPrices.join(', ')}), but lacks interval-spanning dated proof.`;
        }
      } else {
        status = 'INCONCLUSIVE_NO_EVIDENCE';
        reasoning =
          'Recent search snippets did not contain definitive matching pricing figures for direct comparison. Absence of explicit pricing does not confirm that pricing remained unchanged.';
        currentClaimSummary = 'Inconclusive: No direct price match found in current snippets.';
      }
    } else if (hasDatedChangelogEvidence) {
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
  const entityMatch = historicalText.match(
    /\b(HubSpot|Salesforce|Pipedrive|Zoho|Close|Supabase|Neon|Postgres)\b/i
  );
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
    isMock: isMockEvidence,
  };
}
