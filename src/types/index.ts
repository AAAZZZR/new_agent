// ============================================================
// Core Types
// ============================================================

/** Chat message in the conversation */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

/** Tool call requested by the LLM */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result of a tool execution */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// ============================================================
// Session
// ============================================================

export interface Session {
  id: string;
  chatId: number;
  messages: Message[];
  tokenCount: number;
  createdAt: number;
  updatedAt: number;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  senderId: number;
  senderName?: string;
  isOwner: boolean;
}

// ============================================================
// Config
// ============================================================

export interface AppConfig {
  telegram: TelegramConfig;
  llm: LLMConfig;
  mcp: MCPConfig;
  memory: MemoryConfig;
  sandbox: SandboxConfig;
  auth: AuthConfig;
  agent: AgentConfig;
}

export interface TelegramConfig {
  botToken: string;
}

export interface LLMConfig {
  defaultProvider: string;
  defaultModel: string;
  providers: Record<string, LLMProviderConfig>;
  maxRetries: number;
  fallbackProvider?: string;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  models: string[];
}

export interface MCPConfig {
  servers: MCPServerConfig[];
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface MemoryConfig {
  enabled: boolean;
  workspacePath: string;
  search: {
    enabled: boolean;
    embeddingProvider: string;
    embeddingModel: string;
    hybridSearch: boolean;
    temporalDecay: {
      enabled: boolean;
      halfLifeDays: number;
    };
    mmr: {
      enabled: boolean;
      lambda: number;
    };
  };
  compaction: {
    enabled: boolean;
    maxTokens: number;
    reserveTokens: number;
    flushBeforeCompaction: boolean;
  };
}

export interface SandboxConfig {
  enabled: boolean;
  type: 'docker' | 'subprocess';
  timeoutMs: number;
  memoryLimitMb: number;
  dockerImage?: string;
}

export interface AuthConfig {
  ownerId: number;
  guestPermissions: GuestPermissions;
}

export interface GuestPermissions {
  canUseTools: boolean;
  canUseSandbox: boolean;
  canReadMemory: boolean;
  canWriteMemory: boolean;
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  persona?: string;
}

// ============================================================
// LLM Provider Interface
// ============================================================

export interface LLMProvider {
  name: string;
  chat(params: ChatParams): Promise<ChatResponse>;
  countTokens(messages: Message[]): number;
}

export interface ChatParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ============================================================
// Memory Search
// ============================================================

export interface MemorySearchResult {
  text: string;
  path: string;
  lineFrom: number;
  lineTo: number;
  score: number;
}

// ============================================================
// Sandbox
// ============================================================

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
