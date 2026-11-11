import type {
  AgentResponsePayload,
  Message,
  Citation,
  DeltaComparison,
} from '../types/index.js';
import { MemoryStore } from '../memory/db.js';
import { resolveTemporalExpression } from '../memory/temporal.js';
import { type WebSearchProvider, createSearchProvider } from '../tools/search.js';
import { planSearchQueries, executeSearchPlans } from './searchPlanner.js';
import { evaluateDelta } from './deltaEvaluator.js';

export interface ChatAgentConfig {
  memoryStore: MemoryStore;
  searchProvider?: WebSearchProvider;
  geminiApiKey?: string;
  geminiModel?: string;
  timezone?: string;
}

export class ChatAgent {
  private memoryStore: MemoryStore;
  private searchProvider: WebSearchProvider;
  private geminiApiKey?: string;
  private geminiModel: string;
  private timezone: string;

  constructor(config: ChatAgentConfig) {
    this.memoryStore = config.memoryStore;
    this.geminiApiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
    this.geminiModel = config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.timezone = config.timezone || process.env.TIMEZONE || 'Asia/Kolkata';
    this.searchProvider = config.searchProvider || createSearchProvider();
  }

  async handleUserMessage(
    sessionId: string,
    userText: string,
    currentDate: Date = new Date()
  ): Promise<AgentResponsePayload> {
    const userMessageId = `msg-user-${Date.now()}`;
    const userCreatedAt = currentDate.toISOString();

    // 1. Save user message to memory
    this.memoryStore.addMessage({
      id: userMessageId,
      sessionId,
      role: 'user',
      content: userText,
      createdAt: userCreatedAt,
    });

    // 2. Resolve temporal references in the user query against the current timestamp
    const temporalResult = resolveTemporalExpression(userText, currentDate, this.timezone);
    const temporal = temporalResult.temporal;

    // 3. Retrieve relevant conversation history
    const memoryResult = this.memoryStore.searchMemory({
      sessionId,
      temporal,
      keywords: temporalResult.extractedKeywords,
      limit: 10,
    });

    // 4. Formulate targeted search queries
    const searchPlans = planSearchQueries(userText, memoryResult.messages, temporal, {
      maxQueries: 5,
    });

    // 5. Execute search plans concurrently
    const searchExecution = await executeSearchPlans(this.searchProvider, searchPlans);

    // 6. Evaluate delta / fact-drift between historical claims and current evidence
    const delta = evaluateDelta({
      userQuery: userText,
      historicalMessages: memoryResult.messages,
      searchResults: searchExecution.rawResults,
      citations: searchExecution.citations,
      temporal,
    });

    // 7. Synthesize response with citations
    let content = '';

    if (this.geminiApiKey && !this.geminiApiKey.startsWith('your_')) {
      try {
        content = await this.callGeminiSynthesizer({
          userText,
          memoryMessages: memoryResult.messages,
          temporalResult,
          citations: searchExecution.citations,
          delta,
          currentDate,
        });
      } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('Gemini synthesis failed, falling back to deterministic synthesizer:', err);
        }
        content = this.deterministicSynthesize({
          userText,
          memoryMessages: memoryResult.messages,
          temporalResult,
          citations: searchExecution.citations,
          delta,
          memoryExplanation: memoryResult.explanation,
        });
      }
    } else {
      content = this.deterministicSynthesize({
        userText,
        memoryMessages: memoryResult.messages,
        temporalResult,
        citations: searchExecution.citations,
        delta,
        memoryExplanation: memoryResult.explanation,
      });
    }

    // 8. Save assistant reply to memory
    const assistantMessageId = `msg-asst-${Date.now()}`;
    const responsePayload: AgentResponsePayload = {
      sessionId,
      content,
      citations: searchExecution.citations,
      delta,
      temporalContext: {
        anchorDate: currentDate.toISOString(),
        timezone: this.timezone,
        detectedExpressions: temporal ? [temporal.expression] : [],
      },
      searchesExecuted: searchPlans,
      memoryContextUsed: {
        messageCount: memoryResult.messages.length,
        matchedDates: memoryResult.messages.map(m => m.createdAt),
        explanation: memoryResult.explanation,
      },
    };

    this.memoryStore.addMessage({
      id: assistantMessageId,
      sessionId,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      metadata: {
        citations: responsePayload.citations,
        delta: responsePayload.delta,
        searchesExecuted: responsePayload.searchesExecuted,
      },
    });

    return responsePayload;
  }

  private async callGeminiSynthesizer(params: {
    userText: string;
    memoryMessages: Message[];
    temporalResult: ReturnType<typeof resolveTemporalExpression>;
    citations: Citation[];
    delta?: DeltaComparison;
    currentDate: Date;
  }): Promise<string> {
    const { userText, memoryMessages, citations, delta, currentDate } = params;

    const systemPrompt = `You are Minimi, a high-precision AI assistant. You answer fast, get facts right, and ground your answers in both conversation history and web search evidence.
Current Date/Time: ${currentDate.toISOString()} (${this.timezone})

STRICT RULES:
1. Always distinguish what the user asked in past conversations from what is true today.
2. If past conversation memory is provided, explicitly reference the date and past claim.
3. If no relevant past conversation history was found, explicitly declare that no prior record exists—never hallucinate past conversations.
4. When citing web search facts, use citation markers [1], [2] referencing the source IDs provided.
5. In delta comparisons: clearly state what changed, what remained unchanged, or if evidence is inconclusive. Note that missing search results never prove nothing changed.
6. Keep answers concise, factual, and well-structured.`;

    const userPayload = {
      userQuestion: userText,
      priorConversationHistory: memoryMessages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.createdAt,
      })),
      webSearchCitations: citations.map(c => ({
        id: c.id,
        title: c.title,
        url: c.url,
        snippet: c.snippet,
        date: c.publishedDate,
      })),
      precomputedDeltaEvaluation: delta
        ? {
            status: delta.status,
            explanation: delta.explanation,
            historicalClaim: delta.historicalState.claim,
            currentEvidenceSummary: delta.currentState.claim,
          }
        : null,
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${systemPrompt}\n\nContext Data:\n${JSON.stringify(userPayload, null, 2)}\n\nPlease provide a clear, factual, and cited response to the user's question.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1000,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) {
      throw new Error('No candidate text returned by Gemini');
    }

    return candidateText;
  }

  private deterministicSynthesize(params: {
    userText: string;
    memoryMessages: Message[];
    temporalResult: ReturnType<typeof resolveTemporalExpression>;
    citations: Citation[];
    delta?: DeltaComparison;
    memoryExplanation: string;
  }): string {
    const { userText, memoryMessages, citations, delta, memoryExplanation } = params;

    const sections: string[] = [];

    // 1. Historical grounding section
    if (memoryMessages.length > 0) {
      const lastAssistant = [...memoryMessages].reverse().find(m => m.role === 'assistant');
      const lastUser = [...memoryMessages].reverse().find(m => m.role === 'user');

      if (lastUser && lastAssistant) {
        const histDate = new Date(lastUser.createdAt).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
        sections.push(
          `**Past Context (${histDate}):**\n` +
          `• You asked: "${lastUser.content}"\n` +
          `• Previous Answer: ${lastAssistant.content}`
        );
      }
    } else {
      sections.push(`*Note on History:* ${memoryExplanation}`);
    }

    // 2. Delta & Current Reality
    if (delta) {
      const statusLabels: Record<string, string> = {
        VERIFIED_CHANGE: '🔄 Verified Updates Found',
        CONFIRMED_UNCHANGED: '✅ Verified Unchanged',
        INCONCLUSIVE_NO_EVIDENCE: '⚠️ Inconclusive (Absence of Evidence)',
      };

      sections.push(
        `### Current Status: ${statusLabels[delta.status] || delta.status}\n` +
        `• **Evidence Analysis:** ${delta.explanation}\n` +
        `• **Current Verification:** ${delta.currentState.claim}`
      );
    } else if (citations.length > 0) {
      sections.push(
        `### Current Information\n` +
        citations.map(c => `• **${c.title}** [${c.id}]: ${c.snippet}`).join('\n')
      );
    }

    // 3. Citations section
    if (citations.length > 0) {
      sections.push(
        `### Sources & Citations\n` +
        citations
          .map(
            c =>
              `[${c.id}] [${c.title}](${c.url})` +
              (c.publishedDate ? ` — *Published: ${c.publishedDate}*` : '')
          )
          .join('\n')
      );
    }

    return sections.join('\n\n');
  }
}
