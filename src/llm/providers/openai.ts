import OpenAI from 'openai';
import type { LLMProvider, LLMProviderConfig, ChatParams, ChatResponse, Message } from '../../types/index.js';
import { Logger } from '../../utils/logger.js';

const log = new Logger('openai');

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;

  constructor(config: LLMProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      timeout: 120000, // 120s timeout for thinking models
    });
    log.info(`Initialized with baseURL: ${config.baseUrl || 'default'}`);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const messages = this.convertMessages(params.messages);

    const tools = params.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    log.info(`Calling ${params.model} with ${messages.length} messages, ${tools?.length ?? 0} tools`);

    try {
      const response = await this.client.chat.completions.create({
        model: params.model,
        messages,
        ...(tools && tools.length > 0 && { tools }),
        ...(params.maxTokens && { max_tokens: params.maxTokens }),
        ...(params.temperature !== undefined && { temperature: params.temperature }),
      });

      log.info(`Response received: choices=${response.choices.length}, finish=${response.choices[0]?.finish_reason}`);

      const choice = response.choices[0];
      if (!choice) throw new Error('No response from OpenAI');

      const content = choice.message.content ?? '';
      const toolCalls = choice.message.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));

      return {
        content,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
        finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      };
    } catch (err) {
      log.error(`LLM call failed:`, err);
      throw err;
    }
  }

  countTokens(messages: Message[]): number {
    // Rough estimate: ~4 chars per token
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
  }

  private convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      switch (msg.role) {
        case 'system':
          return { role: 'system' as const, content: msg.content };
        case 'user':
          return { role: 'user' as const, content: msg.content };
        case 'assistant':
          if (msg.toolCalls) {
            return {
              role: 'assistant' as const,
              content: msg.content || null,
              tool_calls: msg.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            };
          }
          return { role: 'assistant' as const, content: msg.content };
        case 'tool':
          return {
            role: 'tool' as const,
            tool_call_id: msg.toolCallId ?? '',
            content: msg.content,
          };
        default:
          return { role: 'user' as const, content: msg.content };
      }
    });
  }
}
