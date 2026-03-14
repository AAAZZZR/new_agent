import type { MemorySearchResult } from '../types/index.js';
import type { MemoryStore, MemoryChunk } from './store.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('memory-search');

export interface SearchOptions {
  /** Max results to return */
  limit?: number;
  /** Query embedding vector (if available) */
  queryEmbedding?: Float32Array;
  /** Weight for vector similarity score. Default 0.6 */
  vectorWeight?: number;
  /** Weight for BM25 text score. Default 0.4 */
  textWeight?: number;
  /** Enable temporal decay. Default true */
  temporalDecay?: boolean;
  /** Half-life in days for temporal decay. Default 30 */
  halfLifeDays?: number;
  /** Enable MMR re-ranking. Default true */
  mmrEnabled?: boolean;
  /** MMR lambda (0 = max diversity, 1 = max relevance). Default 0.7 */
  mmrLambda?: number;
}

/** Cosine similarity between two Float32Arrays */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/** Temporal decay: score * e^(-λ * ageInDays) */
function applyTemporalDecay(
  score: number,
  updatedAt: number,
  halfLifeDays: number,
): number {
  const ageMs = Date.now() - updatedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // λ = ln(2) / halfLife
  const lambda = Math.LN2 / halfLifeDays;
  return score * Math.exp(-lambda * ageDays);
}

/** Normalize scores to [0, 1] range */
function normalizeScores(
  items: Array<{ id: string; score: number }>,
): Map<string, number> {
  const map = new Map<string, number>();
  if (items.length === 0) return map;

  const max = Math.max(...items.map((i) => Math.abs(i.score)));
  if (max === 0) {
    items.forEach((i) => map.set(i.id, 0));
    return map;
  }

  items.forEach((i) => map.set(i.id, Math.abs(i.score) / max));
  return map;
}

/**
 * MMR (Maximal Marginal Relevance) re-ranking.
 * Iteratively selects results that balance relevance and diversity.
 */
function mmrRerank(
  candidates: Array<{ chunk: MemoryChunk; score: number }>,
  lambda: number,
  limit: number,
): Array<{ chunk: MemoryChunk; score: number }> {
  if (candidates.length === 0) return [];

  const selected: Array<{ chunk: MemoryChunk; score: number }> = [];
  const remaining = [...candidates];

  // Select highest scoring first
  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift()!);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.score;

      // Max similarity to any already-selected item
      let maxSim = 0;
      for (const sel of selected) {
        if (candidate.chunk.embedding && sel.chunk.embedding) {
          const sim = cosineSimilarity(candidate.chunk.embedding, sel.chunk.embedding);
          maxSim = Math.max(maxSim, sim);
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

export interface SearchEngine {
  search(query: string, store: MemoryStore, options?: SearchOptions): MemorySearchResult[];
}

export function createSearchEngine(): SearchEngine {
  return {
    search(
      query: string,
      store: MemoryStore,
      options: SearchOptions = {},
    ): MemorySearchResult[] {
      const {
        limit = 10,
        queryEmbedding,
        vectorWeight = 0.6,
        textWeight = 0.4,
        temporalDecay = true,
        halfLifeDays = 30,
        mmrEnabled = true,
        mmrLambda = 0.7,
      } = options;

      // Candidate pool: fetch more than needed for re-ranking
      const candidateLimit = limit * 3;

      // ---- BM25 keyword search ----
      const ftsResults = store.searchFTS(query, candidateLimit);
      const ftsScores = normalizeScores(
        ftsResults.map((r) => ({ id: r.id, score: -r.rank })) // FTS5 rank is negative (lower = better)
      );

      // ---- Vector similarity search ----
      const vectorScores = new Map<string, number>();
      if (queryEmbedding) {
        const allChunks = store.getAllChunks();
        for (const chunk of allChunks) {
          if (chunk.embedding) {
            const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
            vectorScores.set(chunk.id, sim);
          }
        }
        // Normalize vector scores
        const maxVec = Math.max(...vectorScores.values(), 0);
        if (maxVec > 0) {
          for (const [id, score] of vectorScores) {
            vectorScores.set(id, score / maxVec);
          }
        }
      }

      // ---- Merge scores ----
      const candidateIds = new Set<string>([
        ...ftsScores.keys(),
        ...vectorScores.keys(),
      ]);

      const scoredCandidates: Array<{ chunk: MemoryChunk; score: number }> = [];

      for (const id of candidateIds) {
        const chunk = store.getChunk(id);
        if (!chunk) continue;

        const fts = ftsScores.get(id) ?? 0;
        const vec = vectorScores.get(id) ?? 0;

        let score = vectorWeight * vec + textWeight * fts;

        // Apply temporal decay
        if (temporalDecay) {
          score = applyTemporalDecay(score, chunk.updatedAt, halfLifeDays);
        }

        scoredCandidates.push({ chunk, score });
      }

      // ---- MMR re-ranking or simple sort ----
      let results: Array<{ chunk: MemoryChunk; score: number }>;

      if (mmrEnabled && queryEmbedding) {
        results = mmrRerank(scoredCandidates, mmrLambda, limit);
      } else {
        results = scoredCandidates
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }

      log.debug(
        `Search "${query.slice(0, 50)}": ${candidateIds.size} candidates → ${results.length} results`
      );

      return results.map((r) => ({
        text: r.chunk.text,
        path: r.chunk.path,
        lineFrom: r.chunk.lineFrom,
        lineTo: r.chunk.lineTo,
        score: r.score,
      }));
    },
  };
}
