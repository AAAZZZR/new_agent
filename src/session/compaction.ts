import type { AppConfig, Message, Session, LLMProvider, ChatParams } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('compaction');

export interface CompactionResult {
  compacted: boolean;
  memoryFlush?: string;    // Important info to save before compacting
  newMessages: Message[];  // Messages after compaction
  removedCount: number;
  summaryTokens: number;
}

/** Rough token count: ~4 chars per token */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Count tokens across all messages */
export function countSessionTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    let tokens = countTokens(m.content);
    // Account for role overhead (~4 tokens per message)
    tokens += 4;
    if (m.name) tokens += countTokens(m.name);
    if (m.toolCalls) {
      tokens += m.toolCalls.reduce(
        (s, tc) => s + countTokens(tc.name) + countTokens(JSON.stringify(tc.arguments)),
        0
      );
    }
    return sum + tokens;
  }, 0);
}

/**
 * Generate a memory flush prompt — asks the LLM to extract important
 * information from the conversation before it gets compacted away.
 */
function buildMemoryFlushPrompt(messages: Message[]): Message {
  const conversation = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n');

  return {
    role: 'user',
    content: `Before we compress this conversation, extract any important information that should be remembered long-term. Include:
- Key facts the user shared about themselves
- Decisions made
- Preferences expressed
- Important context for future conversations
- Any action items or promises

Conversation to review:
${conversation}

Respond with ONLY the important information as bullet points. If nothing is worth saving, respond with "NONE".`,
    timestamp: Date.now(),
  };
}

/**
 * Build a summary prompt for old messages.
 */
function buildSummaryPrompt(messages: Message[]): Message {
  const conversation = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n');

  return {
    role: 'user',
    content: `Summarize this conversation concisely. Preserve key context, decisions, and any ongoing topics. Be brief but complete.

${conversation}

Respond with ONLY the summary.`,
    timestamp: Date.now(),
  };
}

export interface CompactionEngine {
  /**
   * Check if session needs compaction and perform it if so.
   * Returns the result with new messages array.
   */
  compact(session: Session, llm: LLMProvider, model: string): Promise<CompactionResult>;

  /** Check if compaction is needed without performing it */
  needsCompaction(session: Session): boolean;
}

export function createCompactionEngine(config: AppConfig): CompactionEngine {
  const compactionConfig = config.memory.compaction;
  const maxTokens = compactionConfig.maxTokens;
  const reserveTokens = compactionConfig.reserveTokens;
  const flushEnabled = compactionConfig.flushBeforeCompaction;

  // Keep the most recent messages intact
  const KEEP_RECENT = 6;

  return {
    needsCompaction(session: Session): boolean {
      if (!compactionConfig.enabled) return false;
      const tokens = countSessionTokens(session.messages);
      return tokens > maxTokens;
    },

    async compact(
      session: Session,
      llm: LLMProvider,
      model: string,
    ): Promise<CompactionResult> {
      const currentTokens = countSessionTokens(session.messages);

      if (!compactionConfig.enabled || currentTokens <= maxTokens) {
        return {
          compacted: false,
          newMessages: session.messages,
          removedCount: 0,
          summaryTokens: 0,
        };
      }

      log.info(
        `Compacting session ${session.id}: ${currentTokens} tokens > ${maxTokens} threshold`
      );

      const messages = session.messages;

      // Separate system message(s) from conversation
      const systemMessages = messages.filter((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      // Split: old messages to compress vs recent to keep
      const keepCount = Math.min(KEEP_RECENT, conversationMessages.length);
      const oldMessages = conversationMessages.slice(0, -keepCount);
      const recentMessages = conversationMessages.slice(-keepCount);

      if (oldMessages.length === 0) {
        return {
          compacted: false,
          newMessages: session.messages,
          removedCount: 0,
          summaryTokens: 0,
        };
      }

      let memoryFlush: string | undefined;

      // Step 1: Memory flush — extract important info before compaction
      if (flushEnabled) {
        try {
          const flushPrompt = buildMemoryFlushPrompt(oldMessages);
          const flushParams: ChatParams = {
            model,
            messages: [
              { role: 'system', content: 'You extract important information from conversations.', timestamp: Date.now() },
              flushPrompt,
            ],
            maxTokens: 500,
            temperature: 0.3,
          };
          const flushResponse = await llm.chat(flushParams);
          if (flushResponse.content && flushResponse.content.trim() !== 'NONE') {
            memoryFlush = flushResponse.content.trim();
            log.info(`Memory flush extracted ${countTokens(memoryFlush)} tokens of important info`);
          }
        } catch (err) {
          log.error('Memory flush failed, continuing with compaction', err);
        }
      }

      // Step 2: Summarize old messages
      let summary: string;
      try {
        const summaryPrompt = buildSummaryPrompt(oldMessages);
        const summaryParams: ChatParams = {
          model,
          messages: [
            { role: 'system', content: 'You create concise conversation summaries.', timestamp: Date.now() },
            summaryPrompt,
          ],
          maxTokens: reserveTokens,
          temperature: 0.3,
        };
        const summaryResponse = await llm.chat(summaryParams);
        summary = summaryResponse.content;
      } catch (err) {
        log.error('Summary generation failed, using fallback', err);
        // Fallback: just take the last few exchanges from old messages
        summary = oldMessages
          .slice(-4)
          .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
          .join('\n');
      }

      // Step 3: Build compacted message array
      const compactedSystemContent = [
        systemMessages.map((m) => m.content).join('\n\n'),
        `\n\n[Previous conversation summary]\n${summary}`,
      ].join('');

      const compactedSystem: Message = {
        role: 'system',
        content: compactedSystemContent,
        timestamp: Date.now(),
      };

      const newMessages: Message[] = [compactedSystem, ...recentMessages];
      const newTokens = countSessionTokens(newMessages);

      log.info(
        `Compaction complete: ${currentTokens} → ${newTokens} tokens, removed ${oldMessages.length} messages`
      );

      return {
        compacted: true,
        memoryFlush,
        newMessages,
        removedCount: oldMessages.length,
        summaryTokens: countTokens(summary),
      };
    },
  };
}
