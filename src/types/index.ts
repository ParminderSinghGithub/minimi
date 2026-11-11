export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string; // ISO 8601 string, e.g. 2026-11-03T14:30:00.000Z
  metadata?: {
    citations?: Citation[];
    delta?: DeltaComparison;
    searchesExecuted?: SearchQueryPlan[];
    [key: string]: unknown;
  };
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemporalResolution {
  expression: string;
  startDate: string; // ISO string start boundary
  endDate: string; // ISO string end boundary
  isRange: boolean;
  confidence: number;
  referenceTimestamp: string;
  timezone: string;
}

export interface MemoryRetrievalFilter {
  sessionId?: string;
  temporal?: TemporalResolution;
  keywords?: string[];
  limit?: number;
}

export interface MemoryRetrievalResult {
  messages: Message[];
  temporalFilterApplied?: TemporalResolution;
  keywordFilterApplied?: string[];
  hasExactMatch: boolean;
  explanation: string;
}

export type SearchCategory =
  | 'pricing'
  | 'changelog'
  | 'release_notes'
  | 'official'
  | 'general';

export interface SearchQueryPlan {
  query: string;
  category: SearchCategory;
  targetEntity?: string;
  intent: string;
  timeframeHint?: string;
}

export interface SearchResultItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  category?: SearchCategory;
  retrievedAt: string;
}

export type EvidenceStatus =
  | 'VERIFIED_CHANGE'
  | 'CONFIRMED_UNCHANGED'
  | 'INCONCLUSIVE_NO_EVIDENCE';

export interface Citation {
  id: number;
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface DeltaComparison {
  entityOrTopic: string;
  historicalState: {
    date: string;
    claim: string;
    sourceMessageId?: string;
  };
  currentState: {
    claim: string;
    evidenceUrls: string[];
  };
  status: EvidenceStatus;
  explanation: string;
  citations: Citation[];
}

export interface AgentResponsePayload {
  sessionId: string;
  content: string;
  citations: Citation[];
  delta?: DeltaComparison;
  temporalContext: {
    anchorDate: string;
    timezone: string;
    detectedExpressions: string[];
  };
  searchesExecuted: SearchQueryPlan[];
  memoryContextUsed: {
    messageCount: number;
    matchedDates: string[];
    explanation: string;
  };
}
