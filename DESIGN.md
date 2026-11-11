# DESIGN.md • minimi Chat Agent

## 1. How It Works

The minimi chat agent is designed around a core reality revealed by the hiring challenge dataset: **every evaluation prompt requires temporal context recall paired with delta web verification.**

```
User Prompt ("What did I ask on 3 Nov? Is it still correct?")
               │
               ▼
┌────────────────────────────────────────────────────────┐
│ 1. Temporal & Intent Resolver                          │
│    • Resolves relative dates ("Monday", "3 Nov") to ISO│
│    • Identifies search intent (pricing vs. changelog)  │
└──────────────────────┬─────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ 2. SQLite Memory Store (FTS4 + Chronological Window)   │
│    • Exact timestamp range filter [startDate, endDate] │
│    • Sub-millisecond keyword matching (FTS4)           │
│    • Explicit fallback if no prior history exists       │
└──────────────────────┬─────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ 3. Multi-Target Search Planner (The ONE Tool)          │
│    • Fair round-robin query allocation across entities │
│    • Deconstructs complex requests into targeted calls │
│    • Discloses query budget limits & partial coverage  │
│    • Concurrently executes & deduplicates citations   │
└──────────────────────┬─────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ 4. Delta Evaluator & Grounded Synthesizer              │
│    • Compares historical claim vs fresh search evidence│
│    • Status: [VERIFIED_CHANGE | CONFIRMED_UNCHANGED |  │
│      INCONCLUSIVE_NO_EVIDENCE | DEMO_SIMULATION]       │
│    • Current price alone NEVER proves interval constancy│
│    • Mock fixtures never claim live verification       │
│    • Grounded answer with source citations [1], [2]    │
└────────────────────────────────────────────────────────┘
```

### Lifecycle of a Query
1. **Temporal Grounding**: When a query arrives, `resolveTemporalExpression` parses relative expressions (`"on Monday"`, `"last Tuesday"`, `"3 November"`, `"last week"`) using the current timestamp and configured IANA timezone (`Asia/Kolkata` or `UTC`), establishing exact ISO boundaries.
2. **Context Retrieval**: The SQLite memory engine queries messages bounded by that date window combined with FTS4 keyword matching. If keyword matching yields zero hits on an exact date query, it deterministically falls back to all messages within that temporal window for that session, while strictly enforcing session isolation.
3. **Multi-Target Search Planning**: Complex prompts (such as shortlisting 5 CRM tools) are decomposed using fair round-robin allocation across all target vendors and requested change types. If the search budget truncates coverage, unsearched entities are explicitly reported.
4. **Delta & Fact-Drift Verification**: Historical claims from memory are compared with current search snippets. The agent categorizes status as `VERIFIED_CHANGE`, `CONFIRMED_UNCHANGED`, `INCONCLUSIVE_NO_EVIDENCE`, or `DEMO_SIMULATION`. Current prices on official domains without interval-spanning dated confirmation remain inconclusive.
5. **Grounded Synthesis**: The response is synthesized citing real URLs and publication dates. Prompt injection defenses treat all web snippets and user data as untrusted data. If running offline without live API keys, a transparent demo simulation badge is displayed.

---

## 2. Why We Built It This Way

- **SQLite FTS4 over Vector DBs**: Vector embeddings lack chronological awareness. If a user asks *"What did I ask on 3 November?"*, cosine similarity retrieves semantically similar questions from any date. SQLite provides deterministic timestamp range filtering (`created_at BETWEEN ? AND ?`) combined with full-text indexing, with zero cloud infrastructure and sub-millisecond execution.
- **Pure WebAssembly SQLite (`sql.js`)**: Native C++ SQLite modules (like `better-sqlite3`) frequently fail during `npm install` on machines without Visual Studio C++ compilers or Python. Using `sql.js` guarantees that `npm install` succeeds seamlessly on any developer machine (macOS, Linux, Windows).
- **Fair Round-Robin Search Allocation**: A single search query like `"has any of 5 CRM tools changed pricing since monday"` yields generic marketing articles. Breaking it into specific queries across all entities with round-robin allocation prevents budget starvation and ensures every entity receives search coverage.
- **Strict Evidence Handling & Interval Coverage**: The most dangerous agent failure mode is treating the absence of search results as proof that nothing changed, or assuming that observing a current price on an official website proves it remained unchanged across a past interval. Our delta evaluator requires interval-spanning dated confirmation before declaring `CONFIRMED_UNCHANGED`. Mock fixtures are explicitly segregated as `DEMO_SIMULATION`.
- **Dynamic IANA Timezone Calculation & Idempotent Seeding**: Day boundaries and relative offsets (such as `"on Monday"` or `"last Tuesday"`) are dynamically computed using `Intl.DateTimeFormat` against the configured timezone (`Asia/Kolkata` or `UTC`). Demo data seeding is 100% idempotent and anchors timestamps accurately according to the target timezone.

---

## 3. What We Considered and Rejected

- **Vector Databases (Pinecone / Chroma / Faiss)**: Rejected. Vector distance degrades when answering time-anchored questions. For chat sessions, chronological indexing is fundamentally superior to approximate nearest neighbor search.
- **Multi-Agent Orchestration Swarms**: Rejected. Spawning multiple LLM agent roles (e.g., researcher, verifier, summarizer) introduces 5–10s of latency, excessive token consumption, and unpredictable loops for what is cleanly solved by a deterministic query planner and a single search tool.
- **Single Broad Web Search**: Rejected. Search engines optimize for SEO rather than entity-specific diffs. Multi-target decomposition is required to reliably verify multiple vendors.

---

## 4. What We Would Do With Another Week

1. **Background Fact-Drift Daemon (Minimi Proactive Nudges)**:
   In line with minimi's mission (*"AI that lives on your Mac and pings you at the right moment"*), we would build a lightweight macOS background daemon that monitors previous shortlists and pricing claims. When a vendor updates their pricing or ships a major release, it proactively delivers a native Mac notification:
   > *"Pipedrive just raised their Professional plan from $49.90 to $59/mo. Your CRM shortlist has drifted."*
2. **Headless Browser Crawler Fallback**:
   For SaaS tools whose pricing tables or changelogs are rendered entirely client-side via JavaScript, add a local headless browser crawler to render dynamic DOM snapshots when API search snippets are truncated.
3. **Session Branching & Long-Term Compaction**:
   Implement automated topic clustering to maintain fast retrieval across months of user chat history without context degradation.
