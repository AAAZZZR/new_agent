import { Logger } from '../utils/logger.js';

const log = new Logger('chunker');

export interface Chunk {
  path: string;
  lineFrom: number;
  lineTo: number;
  text: string;
  date: string | null; // Extracted from filename YYYY-MM-DD.md
}

export interface ChunkerOptions {
  /** Target chunk size in tokens (~4 chars/token). Default 400 */
  targetTokens?: number;
  /** Overlap between chunks in tokens. Default 80 */
  overlapTokens?: number;
}

const DEFAULT_TARGET = 400;
const DEFAULT_OVERLAP = 80;

/** Extract date from a filename matching YYYY-MM-DD.md */
export function extractDateFromPath(filePath: string): string | null {
  const match = filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  return match ? match[1] : null;
}

/** Rough token count: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split markdown content into overlapping chunks.
 *
 * Strategy:
 * 1. Split on paragraph boundaries (double newlines) first
 * 2. If a paragraph is too big, split on single newlines
 * 3. Merge small paragraphs into chunks up to target size
 * 4. Apply overlap by including trailing lines from previous chunk
 */
export function chunkMarkdown(
  filePath: string,
  content: string,
  options: ChunkerOptions = {},
): Chunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP;
  const date = extractDateFromPath(filePath);

  if (!content.trim()) return [];

  const lines = content.split('\n');
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let chunkStartLine = 1; // 1-indexed

  function flushChunk(): void {
    if (currentLines.length === 0) return;

    const text = currentLines.join('\n').trim();
    if (!text) {
      currentLines = [];
      currentChars = 0;
      return;
    }

    chunks.push({
      path: filePath,
      lineFrom: chunkStartLine,
      lineTo: chunkStartLine + currentLines.length - 1,
      text,
      date,
    });

    // Calculate overlap: keep trailing lines that fit within overlap budget
    let overlapLines: string[] = [];
    let overlapSize = 0;
    for (let i = currentLines.length - 1; i >= 0; i--) {
      const lineSize = currentLines[i].length + 1;
      if (overlapSize + lineSize > overlapChars) break;
      overlapLines.unshift(currentLines[i]);
      overlapSize += lineSize;
    }

    chunkStartLine = chunkStartLine + currentLines.length - overlapLines.length;
    currentLines = overlapLines;
    currentChars = overlapSize;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineChars = line.length + 1; // +1 for newline

    // If adding this line would exceed target, flush first
    if (currentChars + lineChars > targetChars && currentLines.length > 0) {
      flushChunk();
    }

    currentLines.push(line);
    currentChars += lineChars;
  }

  // Flush remaining
  if (currentLines.length > 0) {
    const text = currentLines.join('\n').trim();
    if (text) {
      chunks.push({
        path: filePath,
        lineFrom: chunkStartLine,
        lineTo: chunkStartLine + currentLines.length - 1,
        text,
        date,
      });
    }
  }

  log.debug(`Chunked ${filePath}: ${lines.length} lines → ${chunks.length} chunks`);
  return chunks;
}
