import type { LLMConfig, ChatParams, ChatResponse, LLMProvider } from '../types/index.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('llm-router');

export interface LLMRouter {
  chat(params: ChatParams): Promise<ChatResponse>;
  getProvider(name: string): LLMProvider | undefined;
}

export function createLLMRouter(config: LLMConfig): LLMRouter {
  const providers = new Map<string, LLMProvider>();

  // Initialize configured providers
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    try {
      switch (name) {
        case 'anthropic':
          providers.set(name, new AnthropicProvider(providerConfig));
          break;
        case 'openai':
          providers.set(name, new OpenAIProvider(providerConfig));
          break;
        default:
          log.warn(`Unknown provider: ${name}`);
      }
    } catch (err) {
      log.error(`Failed to initialize provider ${name}:`, err);
    }
  }

  log.info(`Initialized providers: ${[...providers.keys()].join(', ')}`);

  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      // Determine which provider to use from the model name
      const providerName = resolveProvider(params.model, config);
      const provider = providers.get(providerName);

      if (!provider) {
        // Try fallback
        if (config.fallbackProvider) {
          const fallback = providers.get(config.fallbackProvider);
          if (fallback) {
            log.warn(`Provider ${providerName} not available, falling back to ${config.fallbackProvider}`);
            return retry(() => fallback.chat(params), config.maxRetries);
          }
        }
        throw new Error(`No provider available for model ${params.model}`);
      }

      try {
        return await retry(() => provider.chat(params), config.maxRetries);
      } catch (err) {
        // Try fallback on error
        if (config.fallbackProvider && config.fallbackProvider !== providerName) {
          const fallback = providers.get(config.fallbackProvider);
          if (fallback) {
            log.warn(`Provider ${providerName} failed, falling back to ${config.fallbackProvider}`);
            return retry(() => fallback.chat(params), config.maxRetries);
          }
        }
        throw err;
      }
    },

    getProvider(name: string) {
      return providers.get(name);
    },
  };
}

/** Resolve which provider owns a given model */
function resolveProvider(model: string, config: LLMConfig): string {
  // Check if any provider explicitly lists this model
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.models.includes(model)) {
      return name;
    }
  }

  // Heuristic: match by model name prefix
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('gemini')) return 'gemini';

  return config.defaultProvider;
}

/** Retry with exponential backoff */
async function retry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, i), 10000);
        log.warn(`Retry ${i + 1}/${maxRetries} in ${delay}ms: ${lastError.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}
