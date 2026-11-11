# minimi • Chat Agent with Web Search & Temporal Memory

> **minimi hiring challenge submission**: Build the best chat agent with web search you can.

An AI chat agent designed for **temporal conversation memory**, **multi-target web search planning**, and **fact-drift verification** over time.

---

## ⚡ Quickstart

### 1. Clone & Install
```bash
git clone https://github.com/ParminderSinghGithub/minimi.git
cd minimi
npm install
```

### 2. Configure Environment
Copy the example environment file:
```bash
cp .env.example .env
```
Edit `.env` with your API keys:
```env
PORT=3000
TIMEZONE=Asia/Kolkata

# LLM Provider (Google Gemini)
# Get a key at: https://aistudio.google.com/app/apikey
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash

# Web Search Provider (Tavily Search - 1,000 free searches/mo)
# Get a free key at: https://tavily.com
TAVILY_API_KEY=your_tavily_api_key_here
```
*(Note: If no API keys are provided, the agent automatically runs with a built-in hermetic mock searcher and deterministic synthesizer so the entire app and all tests work immediately out of the box!)*

### 3. Run Development Server
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

### 4. Run Automated Tests
```bash
npm test
```

---

## 🎯 Testing the Challenge Dataset Prompts

In the web UI, you can test the three challenge dataset examples with one click:

1. Click **⚡ Seed Challenge History** (or click the quick prompt button). This populates realistic past conversation turns dynamically anchored to current time:
   - Monday shortlist of 5 CRM tools (HubSpot, Salesforce, Pipedrive, Zoho, Close)
   - 3 November discussion of Supabase Pro Postgres hosting
   - Last Tuesday comparison of managed Postgres providers (Neon, Supabase, Aurora Serverless)
2. Click any of the pre-configured prompt buttons:
   - **Prompt 1**: *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"*
   - **Prompt 2**: *"What did I ask you on 3 November? Is your answer still correct today?"*
   - **Prompt 3**: *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*
3. Observe the **Temporal Fact-Check Card**, the **multi-query search breakdown**, and the **verifiable source citations**.

---

## 🏗️ Architecture & Key Highlights

- **Temporal Grounding**: Resolves relative dates (*"last Tuesday"*, *"on Monday"*, *"yesterday"*, *"last week"*) and calendar dates (*"3 November"*) to exact ISO date boundaries against the current reference timestamp and timezone.
- **SQLite Memory Store (FTS4)**: Combines chronological filtering with sub-millisecond full-text search. Exact-date retrieval falls back cleanly to date window boundaries even when keyword search returns zero matches, while strictly maintaining session isolation.
- **Fair Search Planning & Budget Disclosure**: Breaks complex prompts into round-robin queries across all shortlisted entities and intents. Discloses search budget limits and unsearched vendors explicitly rather than claiming false completeness.
- **Strict Evidence Integrity**: Evaluates claims into `VERIFIED_CHANGE`, `CONFIRMED_UNCHANGED`, `INCONCLUSIVE_NO_EVIDENCE`, or `DEMO_SIMULATION`. Current prices alone never prove interval constancy without dated confirmation. Mock fixtures are clearly segregated from live verification.
- **Cross-Platform Zero-Compilers Guarantee**: Built with `sql.js` (WebAssembly SQLite) so `npm install` runs smoothly on any machine without native C++ build tools. Fully idempotent demo seeding respects configured IANA timezones.

---

## 🧪 Test Suite Coverage

Our automated test suite (`npm test`) covers:
- **Temporal Resolution**: Relative date math, absolute dates, ISO dates, and timezone consistency.
- **SQLite Memory**: Session isolation, chronological windowing, FTS keyword matching, and explicit missing history reporting.
- **Search Tooling**: Query decomposition, official pricing/changelog heuristics, URL deduplication, and network timeout recovery.
- **Delta Evaluation**: Pricing comparison, changelog verification, and absence-of-evidence safety.
- **Server Endpoints**: Full API integration for chat, history, and challenge data seeding.

---

## 📄 Design Document
For full details on architectural decisions, trade-offs, and what we considered and rejected, see **[DESIGN.md](./DESIGN.md)**.
