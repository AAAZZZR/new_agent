import Database from 'better-sqlite3';
import type { Message, Session, SessionMetadata } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('session-store');

export interface SessionStore {
  load(chatId: number): Session | null;
  save(session: Session): void;
  delete(chatId: number): void;
  listActive(since?: number): Session[];
  close(): void;
}

interface SessionRow {
  id: string;
  chat_id: number;
  messages: string;
  token_count: number;
  created_at: number;
  updated_at: number;
  metadata: string;
}

export function createSessionStore(dbPath: string): SessionStore {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      chat_id     INTEGER NOT NULL UNIQUE,
      messages    TEXT NOT NULL DEFAULT '[]',
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
  `);

  const stmtLoad = db.prepare<[number]>(
    'SELECT * FROM sessions WHERE chat_id = ?'
  );
  const stmtUpsert = db.prepare(`
    INSERT INTO sessions (id, chat_id, messages, token_count, created_at, updated_at, metadata)
    VALUES (@id, @chat_id, @messages, @token_count, @created_at, @updated_at, @metadata)
    ON CONFLICT(chat_id) DO UPDATE SET
      messages    = @messages,
      token_count = @token_count,
      updated_at  = @updated_at,
      metadata    = @metadata
  `);
  const stmtDelete = db.prepare<[number]>(
    'DELETE FROM sessions WHERE chat_id = ?'
  );
  const stmtListActive = db.prepare<[number]>(
    'SELECT * FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC'
  );

  function rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      chatId: row.chat_id,
      messages: JSON.parse(row.messages) as Message[],
      tokenCount: row.token_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: JSON.parse(row.metadata) as SessionMetadata,
    };
  }

  return {
    load(chatId: number): Session | null {
      const row = stmtLoad.get(chatId) as SessionRow | undefined;
      if (!row) return null;
      log.debug(`Loaded session for chat ${chatId}`);
      return rowToSession(row);
    },

    save(session: Session): void {
      stmtUpsert.run({
        id: session.id,
        chat_id: session.chatId,
        messages: JSON.stringify(session.messages),
        token_count: session.tokenCount,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        metadata: JSON.stringify(session.metadata),
      });
      log.debug(`Saved session for chat ${session.chatId}`);
    },

    delete(chatId: number): void {
      stmtDelete.run(chatId);
      log.info(`Deleted session for chat ${chatId}`);
    },

    listActive(since?: number): Session[] {
      const cutoff = since ?? Date.now() - 7 * 24 * 60 * 60 * 1000; // default 7 days
      const rows = stmtListActive.all(cutoff) as SessionRow[];
      return rows.map(rowToSession);
    },

    close(): void {
      db.close();
      log.info('Session store closed');
    },
  };
}
