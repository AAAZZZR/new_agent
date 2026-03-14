import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig, MemorySearchResult } from '../types/index.js';
import { createMemoryStore, type MemoryStore, type MemoryChunk } from './store.js';
import { chunkMarkdown } from './chunker.js';
import { createSearchEngine, type SearchEngine, type SearchOptions } from './search.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('memory');

export interface MemoryManager {
  /** Initialize: index existing files, start watching */
  init(): Promise<void>;

  /** Search memory for relevant chunks */
  search(query: string, options?: SearchOptions): MemorySearchResult[];

  /** Get raw text from a file at specific line range */
  get(path: string, from: number, lines: number): Promise<string | null>;

  /** Manually trigger re-index of a file */
  reindex(filePath: string): Promise<void>;

  /** Shutdown: close watcher and database */
  close(): void;
}

export function createMemoryManager(config: AppConfig): MemoryManager {
  const memoryConfig = config.memory;
  const workspacePath = memoryConfig.workspacePath;
  const dbPath = join(workspacePath, '.memory.db');

  let store: MemoryStore;
  let searchEngine: SearchEngine;
  let watcher: FSWatcher | null = null;
  const indexedHashes = new Map<string, string>(); // path → content hash

  function generateChunkId(path: string, lineFrom: number, lineTo: number): string {
    return createHash('md5')
      .update(`${path}:${lineFrom}:${lineTo}`)
      .digest('hex')
      .slice(0, 16);
  }

  async function indexFile(filePath: string): Promise<void> {
    try {
      const fullPath = join(workspacePath, filePath);
      const content = await readFile(fullPath, 'utf-8');

      // Check if content changed
      const hash = createHash('md5').update(content).digest('hex');
      if (indexedHashes.get(filePath) === hash) {
        return; // No change
      }

      // Remove old chunks for this path
      store.deleteByPath(filePath);

      // Chunk the content
      const chunks = chunkMarkdown(filePath, content);

      // Convert to MemoryChunks (embeddings added later if enabled)
      const memoryChunks: MemoryChunk[] = chunks.map((c) => ({
        id: generateChunkId(c.path, c.lineFrom, c.lineTo),
        path: c.path,
        lineFrom: c.lineFrom,
        lineTo: c.lineTo,
        text: c.text,
        embedding: null, // Embeddings computed separately
        updatedAt: Date.now(),
      }));

      if (memoryChunks.length > 0) {
        store.upsertChunks(memoryChunks);
      }

      indexedHashes.set(filePath, hash);
      log.info(`Indexed ${filePath}: ${memoryChunks.length} chunks`);
    } catch (err) {
      log.error(`Failed to index ${filePath}`, err);
    }
  }

  async function indexDirectory(dirPath: string): Promise<void> {
    try {
      const fullDir = join(workspacePath, dirPath);
      const entries = await readdir(fullDir, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);

        if (entry.name.startsWith('.')) continue; // Skip hidden files

        if (entry.isDirectory()) {
          await indexDirectory(entryPath);
        } else if (entry.name.endsWith('.md')) {
          await indexFile(entryPath);
        }
      }
    } catch (err) {
      log.error(`Failed to index directory ${dirPath}`, err);
    }
  }

  function startWatcher(): void {
    try {
      const memoryDir = join(workspacePath, 'memory');
      watcher = watch(memoryDir, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;

        const filePath = join('memory', filename);
        log.debug(`File ${eventType}: ${filePath}`);

        // Debounce: re-index after a short delay
        setTimeout(() => {
          indexFile(filePath).catch((err) =>
            log.error(`Re-index failed for ${filePath}`, err)
          );
        }, 500);
      });

      log.info('File watcher started on memory directory');
    } catch (err) {
      log.warn('Could not start file watcher (directory may not exist yet)', err);
    }
  }

  return {
    async init(): Promise<void> {
      if (!memoryConfig.enabled) {
        log.info('Memory disabled by config');
        return;
      }

      store = createMemoryStore(dbPath);
      searchEngine = createSearchEngine();

      // Index existing files
      await indexDirectory('memory');

      // Also index root-level markdown files (MEMORY.md, etc.)
      try {
        const rootEntries = await readdir(workspacePath, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
            await indexFile(entry.name);
          }
        }
      } catch (err) {
        log.error('Failed to index root markdown files', err);
      }

      // Start watching for changes
      startWatcher();

      log.info('Memory manager initialized');
    },

    search(query: string, options?: SearchOptions): MemorySearchResult[] {
      if (!store) return [];
      return searchEngine.search(query, store, {
        halfLifeDays: memoryConfig.search.temporalDecay.halfLifeDays,
        mmrEnabled: memoryConfig.search.mmr.enabled,
        mmrLambda: memoryConfig.search.mmr.lambda,
        ...options,
      });
    },

    async get(path: string, from: number, lines: number): Promise<string | null> {
      try {
        const fullPath = join(workspacePath, path);
        const content = await readFile(fullPath, 'utf-8');
        const allLines = content.split('\n');

        // from is 1-indexed
        const startIdx = Math.max(0, from - 1);
        const endIdx = Math.min(allLines.length, startIdx + lines);

        return allLines.slice(startIdx, endIdx).join('\n');
      } catch {
        return null;
      }
    },

    async reindex(filePath: string): Promise<void> {
      indexedHashes.delete(filePath);
      await indexFile(filePath);
    },

    close(): void {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (store) {
        store.close();
      }
      log.info('Memory manager closed');
    },
  };
}
