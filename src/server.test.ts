import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp } from './server.js';
import { MemoryStore } from './memory/db.js';
import { ChatAgent } from './agent/orchestrator.js';
import { MockSearchProvider } from './tools/search.js';
import type express from 'express';
import { EventEmitter } from 'events';

// Lightweight, zero-socket Express test runner
function executeRequest(
  app: express.Express,
  method: string,
  url: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as any;
    req.method = method;
    req.url = url;
    req.headers = { 'content-type': 'application/json' };
    req.body = body || {};

    let statusCode = 200;
    let responseData = '';

    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: any) {
        resolve({ status: statusCode, body: data });
      },
      send(data: any) {
        responseData = data;
        resolve({ status: statusCode, body: responseData });
      },
      setHeader() {
        return res;
      },
    };

    app.handle(req, res, () => {
      resolve({ status: 404, body: { error: 'Not found' } });
    });
  });
}

describe('Server Endpoints Integration (Pure In-Memory Dispatch)', () => {
  let app: express.Express;
  let memoryStore: MemoryStore;
  let agent: ChatAgent;

  beforeAll(async () => {
    memoryStore = new MemoryStore(':memory:');
    await memoryStore.initialize();
    const mockSearch = new MockSearchProvider();
    agent = new ChatAgent({
      memoryStore,
      searchProvider: mockSearch,
      timezone: 'UTC',
    });
    app = await setupApp(memoryStore, agent);
  });

  it('GET /api/health should return ok status', async () => {
    const res = await executeRequest(app, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('minimi-chat-agent');
  });

  it('POST /api/seed should populate challenge demo data', async () => {
    const res = await executeRequest(app, 'POST', '/api/seed', {
      sessionId: 'server-test-session',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify messages exist in history
    const historyRes = await executeRequest(app, 'GET', '/api/history/server-test-session');
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.messages.length).toBeGreaterThanOrEqual(6);
  });

  it('POST /api/chat should validate empty message', async () => {
    const res = await executeRequest(app, 'POST', '/api/chat', {
      sessionId: 'server-test-session',
      message: '   ',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });

  it('POST /api/chat should answer queries and return citations and delta', async () => {
    const res = await executeRequest(app, 'POST', '/api/chat', {
      sessionId: 'server-test-session',
      message: 'What did I ask you on 3 November? Is your answer still correct today?',
      currentDate: '2026-11-11T12:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(res.body.content).toBeDefined();
    expect(res.body.citations).toBeDefined();
    expect(res.body.citations.length).toBeGreaterThan(0);
    expect(res.body.delta).toBeDefined();
    expect(res.body.memoryContextUsed.messageCount).toBeGreaterThan(0);
  });
});
