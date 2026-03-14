import Database from 'better-sqlite3';
import { Logger } from '../utils/logger.js';

const log = new Logger('memory-store');

export interface MemoryChunk {
  id: string;
  path: string;
  lineFrom: number;
  lineTo: number;
  text: string;
  embedding: Float32Array | null;
  updatedAt: number;
}

export interface MemoryStore {
  upsertChunk(chunk: MemoryChunk): void;
  upsertChunks(chunks: MemoryChunk[]): void;
  getChunk(id: string): MemoryChunk | null;
  getChunksByPath(path: string): MemoryChunk[];
  deleteByPath(path: string): number;
  searchFTS(query: string, limit?: number): Array<{ id: string; text: string; rank: number }>;
  getAllChunks(): MemoryChunk[];
  close(): void;
}

interface ChunkRow {
  id: string;
  path: string;
  line_from: number;
  line_to: number;
  text: string;
  embedding: Buffer | null;
  updated_at: number;
}

interface FTSRow {
  id: string;
  text: string;
  rank: number;
}

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function bufferToEmbedding(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function createMemoryStore(dbPath: string): MemoryStore {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      line_from  INTEGER NOT NULL,
      line_to    INTEGER NOT NULL,
      text       TEXT NOT NULL,
      embedding  BLOB,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_updated_at ON chunks(updated_at);
  `);

  // FTS5 virtual table for BM25 keyword search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      id UNINDEXED,
      text,
      content='chunks',
      content_rowid='rowid'
    );
  `);

  // Triggers to keep FTS in sync with chunks table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
      INSERT INTO chunks_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
  `);

  const stmtUpsert = db.prepare(`
    INSERT INTO chunks (id, path, line_from, line_to, text, embedding, updated_at)
    VALUES (@id, @path, @line_from, @line_to, @text, @embedding, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      path       = @path,
      line_from  = @line_from,
      line_to    = @line_to,
      text       = @text,
      embedding  = @embedding,
      updated_at = @updated_at
  `);

  const stmtGet = db.prepare<[string]>('SELECT * FROM chunks WHERE id = ?');
  const stmtByPath = db.prepare<[string]>('SELECT * FROM chunks WHERE path = ? ORDER BY line_from');
  const stmtDeleteByPath = db.prepare<[string]>('DELETE FROM chunks WHERE path = ?');
  const stmtAll = db.prepare('SELECT * FROM chunks ORDER BY path, line_from');

  const stmtFTS = db.prepare<[string, number]>(
    `SELECT id, text, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`
  );

  const upsertMany = db.transaction((chunks: MemoryChunk[]) => {
    for (const chunk of chunks) {
      stmtUpsert.run({
        id: chunk.id,
        path: chunk.path,
        line_from: chunk.lineFrom,
        line_to: chunk.lineTo,
        text: chunk.text,
        embedding: chunk.embedding ? embeddingToBuffer(chunk.embedding) : null,
        updated_at: chunk.updatedAt,
      });
    }
  });

  function rowToChunk(row: ChunkRow): MemoryChunk {
    return {
      id: row.id,
      path: row.path,
      lineFrom: row.line_from,
      lineTo: row.line_to,
      text: row.text,
      embedding: row.embedding ? bufferToEmbedding(row.embedding) : null,
      updatedAt: row.updated_at,
    };
  }

  return {
    upsertChunk(chunk: MemoryChunk): void {
      stmtUpsert.run({
        id: chunk.id,
        path: chunk.path,
        line_from: chunk.lineFrom,
        line_to: chunk.lineTo,
        text: chunk.text,
        embedding: chunk.embedding ? embeddingToBuffer(chunk.embedding) : null,
        updated_at: chunk.updatedAt,
      });
    },

    upsertChunks(chunks: MemoryChunk[]): void {
      upsertMany(chunks);
      log.debug(`Upserted ${chunks.length} chunks`);
    },

    getChunk(id: string): MemoryChunk | null {
      const row = stmtGet.get(id) as ChunkRow | undefined;
      return row ? rowToChunk(row) : null;
    },

    getChunksByPath(path: string): MemoryChunk[] {
      const rows = stmtByPath.all(path) as ChunkRow[];
      return rows.map(rowToChunk);
    },

    deleteByPath(path: string): number {
      const result = stmtDeleteByPath.run(path);
      log.debug(`Deleted ${result.changes} chunks for path: ${path}`);
      return result.changes;
    },

    searchFTS(query: string, limit = 20): Array<{ id: string; text: string; rank: number }> {
      try {
        // Escape special FTS5 characters and build query
        const sanitized = query.replace(/['"]/g, '').trim();
        if (!sanitized) return [];
        const rows = stmtFTS.all(sanitized, limit) as FTSRow[];
        return rows;
      } catch (err) {
        log.error('FTS search failed', err);
        return [];
      }
    },

    getAllChunks(): MemoryChunk[] {
      const rows = stmtAll.all() as ChunkRow[];
      return rows.map(rowToChunk);
    },

    close(): void {
      db.close();
      log.info('Memory store closed');
    },
  };
}
