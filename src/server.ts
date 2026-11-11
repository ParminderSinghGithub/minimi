import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryStore } from './memory/db.js';
import { ChatAgent } from './agent/orchestrator.js';
import { createSearchProvider } from './tools/search.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const host = process.env.HOST || 'localhost';
const dbPath = process.env.DATABASE_PATH || './data/minimi.db';

app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Serve static frontend assets from public/
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

let memoryStore: MemoryStore;
let chatAgent: ChatAgent;

const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export async function setupApp(customMemory?: MemoryStore, customAgent?: ChatAgent): Promise<express.Express> {
  if (customMemory && customAgent) {
    memoryStore = customMemory;
    chatAgent = customAgent;
  } else {
    memoryStore = new MemoryStore(dbPath);
    await memoryStore.initialize();

    const searchProvider = createSearchProvider();
    chatAgent = new ChatAgent({
      memoryStore,
      searchProvider,
      timezone: process.env.TIMEZONE || 'Asia/Kolkata',
    });
  }

  return app;
}

// Health check endpoint
app.get('/api/health', (_req, res) => {
  const isReady = Boolean(memoryStore && chatAgent);
  const tavilyKey = process.env.TAVILY_API_KEY;
  const isLiveSearch = Boolean(
    tavilyKey && !tavilyKey.startsWith('your_') && process.env.SEARCH_PROVIDER !== 'mock'
  );
  const geminiKey = process.env.GEMINI_API_KEY;
  const isLiveLLM = Boolean(geminiKey && !geminiKey.startsWith('your_'));

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ok' : 'initializing',
    service: 'minimi-chat-agent',
    mode: isLiveSearch ? 'live' : 'demo_simulation',
    providers: {
      search: isLiveSearch ? 'tavily_live' : 'mock_simulation',
      llm: isLiveLLM ? 'gemini_live' : 'deterministic_simulation',
    },
    timestamp: new Date().toISOString(),
    timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  });
});

// Guard middleware to ensure services are ready before processing requests
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!memoryStore || !chatAgent) {
    res.status(503).json({ error: 'Service is initializing. Please try again in a moment.' });
    return;
  }
  next();
});

// Seed challenge demo history endpoint
app.post('/api/seed', (req, res) => {
  try {
    const rawSessionId = req.body?.sessionId;
    const sessionId = typeof rawSessionId === 'string' && rawSessionId.trim() !== ''
      ? rawSessionId.trim()
      : 'default-session';

    if (!SESSION_ID_REGEX.test(sessionId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid sessionId. Must be 1-64 alphanumeric characters, dashes, or underscores.',
      });
      return;
    }

    memoryStore.seedChallengeDemoData(sessionId, new Date(), process.env.TIMEZONE || 'Asia/Kolkata');
    res.json({
      success: true,
      sessionId,
      message: 'Challenge test dataset history successfully seeded into conversation memory.',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// Chat message endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId = 'default-session', message, currentDate } = req.body || {};

    if (typeof sessionId !== 'string' || !SESSION_ID_REGEX.test(sessionId)) {
      res.status(400).json({
        error: 'Invalid sessionId. Must be 1-64 alphanumeric characters, dashes, or underscores.',
      });
      return;
    }

    if (!message || typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'Message content is required.' });
      return;
    }

    let anchorDate = new Date();
    if (currentDate) {
      const parsedDate = new Date(currentDate);
      if (!isNaN(parsedDate.getTime())) {
        anchorDate = parsedDate;
      }
    }

    const responsePayload = await chatAgent.handleUserMessage(sessionId, message.trim(), anchorDate);

    res.json(responsePayload);
  } catch (err: unknown) {
    console.error('Chat endpoint error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Session history endpoint
app.get('/api/history/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
      res.status(400).json({
        error: 'Invalid sessionId. Must be 1-64 alphanumeric characters, dashes, or underscores.',
      });
      return;
    }

    const messages = memoryStore.getRecentMessages(sessionId, 50);
    res.json({ sessionId, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Clean index fallback for SPA
app.get('*', (_req, res, next) => {
  const indexPath = path.join(publicDir, 'index.html');
  res.sendFile(indexPath, err => {
    if (err) next();
  });
});

// Auto-start server in non-test mode
if (process.env.NODE_ENV !== 'test') {
  setupApp()
    .then(() => {
      app.listen(port, host, () => {
        console.log(`\n==================================================`);
        console.log(`  Minimi Chat Agent running at: http://${host}:${port}`);
        console.log(`  Web Search: ${process.env.SEARCH_PROVIDER || 'tavily'}`);
        console.log(`  Timezone:   ${process.env.TIMEZONE || 'Asia/Kolkata'}`);
        console.log(`==================================================\n`);
      });
    })
    .catch(err => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}

export default app;
