import initSqlJs, { Database as SqlDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  Message,
  Session,
  MemoryRetrievalFilter,
  MemoryRetrievalResult,
} from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class MemoryStore {
  private db: SqlDatabase | null = null;
  private dbPath: string | null;

  constructor(dbPath: string | null = null) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    const wasmPath = path.resolve(__dirname, '../../node_modules/sql.js/dist');
    const SQL = await initSqlJs({
      locateFile: (file: string) => path.join(wasmPath, file),
    });

    if (this.dbPath && this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    this.setupSchema();
  }

  private setupSchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts4(
        content,
        message_id,
        session_id
      );
    `);

    this.persist();
  }

  private persist(): void {
    if (!this.db || !this.dbPath || this.dbPath === ':memory:') return;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  createSession(id: string = `sess-${Date.now()}`, title: string = 'New Conversation'): Session {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();

    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run([id, title, now, now]);
    stmt.free();

    this.persist();
    return { id, title, createdAt: now, updatedAt: now };
  }

  getSession(id: string): Session | null {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; title: string; created_at: string; updated_at: string };
      stmt.free();
      return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    stmt.free();
    return null;
  }

  addMessage(message: Message): Message {
    if (!this.db) throw new Error('Database not initialized');

    // Ensure session exists
    if (!this.getSession(message.sessionId)) {
      this.createSession(message.sessionId, 'Conversation');
    }

    const metadataStr = message.metadata ? JSON.stringify(message.metadata) : null;

    const stmt = this.db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmt.run([
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.createdAt,
      metadataStr,
    ]);
    stmt.free();

    // Insert into FTS index
    const ftsStmt = this.db.prepare(
      'INSERT INTO messages_fts (content, message_id, session_id) VALUES (?, ?, ?)'
    );
    ftsStmt.run([message.content, message.id, message.sessionId]);
    ftsStmt.free();

    // Update session updated_at
    const sessStmt = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    sessStmt.run([new Date().toISOString(), message.sessionId]);
    sessStmt.free();

    this.persist();
    return message;
  }

  getRecentMessages(sessionId: string, limit: number = 20): Message[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      'SELECT id, session_id, role, content, created_at, metadata FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
    );
    stmt.bind([sessionId, limit]);

    const results: Message[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        session_id: string;
        role: string;
        content: string;
        created_at: string;
        metadata: string | null;
      };
      results.push({
        id: row.id,
        sessionId: row.session_id,
        role: row.role as Message['role'],
        content: row.content,
        createdAt: row.created_at,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    }
    stmt.free();
    return results;
  }

  searchMemory(filter: MemoryRetrievalFilter): MemoryRetrievalResult {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.sessionId) {
      conditions.push('m.session_id = ?');
      params.push(filter.sessionId);
    }

    if (filter.temporal) {
      conditions.push('m.created_at >= ? AND m.created_at <= ?');
      params.push(filter.temporal.startDate);
      params.push(filter.temporal.endDate);
    }

    // Keyword filtering with FTS
    let ftsMessageIds: Set<string> | null = null;
    if (filter.keywords && filter.keywords.length > 0) {
      ftsMessageIds = new Set<string>();
      for (const kw of filter.keywords) {
        // Safe FTS query: wrap words
        const safeKw = kw.replace(/['"*]/g, '');
        if (!safeKw) continue;
        try {
          const ftsStmt = this.db.prepare(
            `SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?`
          );
          ftsStmt.bind([`${safeKw}*`]);
          while (ftsStmt.step()) {
            const row = ftsStmt.getAsObject() as { message_id: string };
            ftsMessageIds.add(row.message_id);
          }
          ftsStmt.free();
        } catch {
          // Fallback to LIKE if FTS tokenization fails
          const likeStmt = this.db.prepare(
            `SELECT id FROM messages WHERE content LIKE ?`
          );
          likeStmt.bind([`%${safeKw}%`]);
          while (likeStmt.step()) {
            const row = likeStmt.getAsObject() as { id: string };
            ftsMessageIds.add(row.id);
          }
          likeStmt.free();
        }
      }
    }

    let query = `
      SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.metadata
      FROM messages m
    `;

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY m.created_at ASC';

    if (filter.limit) {
      query += ` LIMIT ${filter.limit}`;
    }

    const stmt = this.db.prepare(query);
    stmt.bind(params);

    const messages: Message[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        session_id: string;
        role: string;
        content: string;
        created_at: string;
        metadata: string | null;
      };

      // If keyword filter was specified, prioritize messages matching keywords
      if (ftsMessageIds && ftsMessageIds.size > 0) {
        if (ftsMessageIds.has(row.id)) {
          messages.push({
            id: row.id,
            sessionId: row.session_id,
            role: row.role as Message['role'],
            content: row.content,
            createdAt: row.created_at,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          });
        }
      } else {
        messages.push({
          id: row.id,
          sessionId: row.session_id,
          role: row.role as Message['role'],
          content: row.content,
          createdAt: row.created_at,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
    }
    stmt.free();

    // If temporal filter was applied but yielded no messages with keywords,
    // fallback to all messages from that temporal window so the agent knows what occurred
    if (messages.length === 0 && filter.temporal && ftsMessageIds && ftsMessageIds.size > 0) {
      const fallbackStmt = this.db.prepare(
        'SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.metadata FROM messages m WHERE m.created_at >= ? AND m.created_at <= ? ORDER BY m.created_at ASC'
      );
      fallbackStmt.bind([filter.temporal.startDate, filter.temporal.endDate]);
      while (fallbackStmt.step()) {
        const row = fallbackStmt.getAsObject() as {
          id: string;
          session_id: string;
          role: string;
          content: string;
          created_at: string;
          metadata: string | null;
        };
        messages.push({
          id: row.id,
          sessionId: row.session_id,
          role: row.role as Message['role'],
          content: row.content,
          createdAt: row.created_at,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
      fallbackStmt.free();
    }

    const hasExactMatch = messages.length > 0;
    let explanation = '';

    if (hasExactMatch) {
      explanation = `Retrieved ${messages.length} conversation message(s) from memory.`;
    } else if (filter.temporal) {
      explanation = `No prior conversation history found for date range [${filter.temporal.startDate} to ${filter.temporal.endDate}] (expression: "${filter.temporal.expression}").`;
    } else if (filter.keywords && filter.keywords.length > 0) {
      explanation = `No prior conversation history found discussing topics: ${filter.keywords.join(', ')}.`;
    } else {
      explanation = 'No prior conversation history found.';
    }

    return {
      messages,
      temporalFilterApplied: filter.temporal,
      keywordFilterApplied: filter.keywords,
      hasExactMatch,
      explanation,
    };
  }

  /**
   * Seeds demo data corresponding to the 3 challenge dataset examples with realistic timestamps
   */
  seedChallengeDemoData(sessionId: string, referenceDate: Date = new Date()): void {
    const anchorYear = referenceDate.getFullYear();
    const anchorMonth = referenceDate.getMonth();
    const anchorDay = referenceDate.getDate();
    const anchorDow = referenceDate.getDay();

    // 1. "On Monday we shortlisted 5 CRM tools for a 20-person sales team."
    // Calculate Monday relative to anchor
    const daysSinceMonday = (anchorDow - 1 + 7) % 7 || 7;
    const mondayDate = new Date(referenceDate.getTime() - daysSinceMonday * 86400000);
    mondayDate.setHours(10, 30, 0, 0);

    this.addMessage({
      id: `demo-crm-user-${sessionId}`,
      sessionId,
      role: 'user',
      content: 'Can you shortlist 5 CRM tools for our 20-person sales team?',
      createdAt: mondayDate.toISOString(),
    });

    this.addMessage({
      id: `demo-crm-asst-${sessionId}`,
      sessionId,
      role: 'assistant',
      content:
        'Here are 5 shortlisted CRM tools suited for a 20-person sales team:\n' +
        '1. HubSpot Sales Hub Pro: $100/seat/month (requires annual commitment).\n' +
        '2. Salesforce Sales Cloud Enterprise: $165/user/month.\n' +
        '3. Pipedrive Professional: $49.90/user/month.\n' +
        '4. Zoho CRM Enterprise: $40/user/month.\n' +
        '5. Close CRM Growth: $99/user/month (ideal for outbound email & calling).\n' +
        'For 20 seats, Pipedrive or Zoho offer the best balance of cost and sales pipeline automation.',
      createdAt: new Date(mondayDate.getTime() + 120000).toISOString(),
    });

    // 2. "What did I ask you on 3 November? Is your answer still correct today?"
    // 3 November of current anchor year (or last year if anchor is before Nov 3)
    let nov3Year = anchorYear;
    if (anchorMonth < 10 || (anchorMonth === 10 && anchorDay < 3)) {
      nov3Year = anchorYear - 1;
    }
    const nov3Date = new Date(Date.UTC(nov3Year, 10, 3, 14, 15, 0));

    this.addMessage({
      id: `demo-nov3-user-${sessionId}`,
      sessionId,
      role: 'user',
      content: 'What is the pricing for Supabase Pro Postgres hosting and what are the included compute resources?',
      createdAt: nov3Date.toISOString(),
    });

    this.addMessage({
      id: `demo-nov3-asst-${sessionId}`,
      sessionId,
      role: 'assistant',
      content:
        'As of November 3, Supabase Pro plan is $25/month. It includes 8 GB disk storage, 100,000 monthly active users, 250 GB bandwidth, and $10 in compute credits (Micro compute instance with 2 vCPU and 1 GB RAM included). Additional compute sizes range from Small ($15/mo) to 16XL ($1,920/mo).',
      createdAt: new Date(nov3Date.getTime() + 150000).toISOString(),
    });

    // 3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
    // Calculate last Tuesday relative to anchor
    const daysSinceLastTuesday = (anchorDow - 2 + 7) % 7 || 7;
    const lastTuesdayDate = new Date(referenceDate.getTime() - daysSinceLastTuesday * 86400000);
    lastTuesdayDate.setHours(16, 0, 0, 0);

    this.addMessage({
      id: `demo-tues-user-${sessionId}`,
      sessionId,
      role: 'user',
      content: 'Can you compare Postgres hosting options between Neon, Supabase, and AWS RDS Aurora Serverless?',
      createdAt: lastTuesdayDate.toISOString(),
    });

    this.addMessage({
      id: `demo-tues-asst-${sessionId}`,
      sessionId,
      role: 'assistant',
      content:
        'Here is the comparison between top serverless/managed Postgres providers:\n' +
        '- Neon Postgres: Serverless compute starts at $0.16/CU-hour (scale-to-zero supported), with Launch plan at $19/mo and Scale plan at $69/mo.\n' +
        '- Supabase: Managed Postgres on AWS with Pro tier starting at $25/mo plus compute add-ons.\n' +
        '- AWS Aurora Serverless v2: Billed per ACU (Aurora Capacity Unit) at approximately $0.12 per ACU-hour plus storage I/O.',
      createdAt: new Date(lastTuesdayDate.getTime() + 180000).toISOString(),
    });
  }
}
