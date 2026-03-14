import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMProviderConfig, ChatParams, ChatResponse, Message } from '../../types/index.js';
import { Logger } from '../../utils/logger.js';

const log = new Logger('anthropic');

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  private client: Anthropic;

  constructor(config: LLMProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Separate system messages from the rest
    const systemMessages = params.messages.filter(m => m.role === 'system');
    const conversationMessages = params.messages.filter(m => m.role !== 'system');

    // Build Anthropic messages
    const messages = this.convertMessages(conversationMessages);

    // Build tools
    const tools = params.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      ...(systemMessages.length > 0 && {
        system: systemMessages.map(m => m.content).join('\n\n'),
      }),
      messages,
      ...(tools && tools.length > 0 && { tools }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    });

    // Parse response
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    const content = textBlocks.map(b => b.text).join('');
    const toolCalls = toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name,
      arguments: b.input as Record<string, unknown>,
    }));

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    };
  }

  countTokens(messages: Message[]): number {
    // Rough estimate: ~4 chars per token
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const content: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: call.arguments,
            });
          }
        }
        result.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        // Anthropic expects tool results in a user message
        // Check if last message is already a user message with tool results
        const lastMsg = result[result.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: msg.content,
        };

        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Anthropic.ToolResultBlockParam[]).push(toolResultBlock);
        } else {
          result.push({ role: 'user', content: [toolResultBlock] });
        }
      } else if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      }
    }

    return result;
  }
}
