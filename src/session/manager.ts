import type { AppConfig, Message, Session, SessionMetadata } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('session');

export interface SessionManager {
  getOrCreate(chatId: number, metadata: SessionMetadata): Session;
  getMessages(chatId: number): Message[];
  addMessage(chatId: number, message: Message): void;
  updateTokenCount(chatId: number, tokens: number): void;
  clear(chatId: number): void;
  getSession(chatId: number): Session | undefined;
}

export function createSessionManager(config: AppConfig): SessionManager {
  const sessions = new Map<number, Session>();

  function getSystemMessage(): Message {
    const parts: string[] = [];

    if (config.agent.systemPrompt) {
      parts.push(config.agent.systemPrompt);
    }
    if (config.agent.persona) {
      parts.push(config.agent.persona);
    }

    return {
      role: 'system',
      content: parts.join('\n\n'),
      timestamp: Date.now(),
    };
  }

  return {
    getOrCreate(chatId: number, metadata: SessionMetadata): Session {
      let session = sessions.get(chatId);
      if (!session) {
        session = {
          id: `session_${chatId}_${Date.now()}`,
          chatId,
          messages: [getSystemMessage()],
          tokenCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata,
        };
        sessions.set(chatId, session);
        log.info(`New session for chat ${chatId} (owner: ${metadata.isOwner})`);
      }
      return session;
    },

    getMessages(chatId: number): Message[] {
      const session = sessions.get(chatId);
      if (!session) return [getSystemMessage()];
      return session.messages;
    },

    addMessage(chatId: number, message: Message): void {
      const session = sessions.get(chatId);
      if (!session) return;

      session.messages.push(message);
      session.updatedAt = Date.now();

      // TODO: Check if compaction needed (Phase 3)
    },

    updateTokenCount(chatId: number, tokens: number): void {
      const session = sessions.get(chatId);
      if (!session) return;
      session.tokenCount = tokens;
    },

    clear(chatId: number): void {
      sessions.delete(chatId);
      log.info(`Session cleared for chat ${chatId}`);
    },

    getSession(chatId: number): Session | undefined {
      return sessions.get(chatId);
    },
  };
}
