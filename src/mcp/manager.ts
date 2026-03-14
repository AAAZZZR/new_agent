import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConfig, MCPServerConfig, ToolDefinition } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('mcp');

// ============================================================
// Types
// ============================================================

interface ConnectedServer {
  name: string;
  client: Client;
  tools: ToolDefinition[];
  config: MCPServerConfig;
  reconnectAttempts: number;
  connected: boolean;
}

export interface MCPManagerOptions {
  /** Timeout for individual tool calls in ms (default: 30000) */
  toolCallTimeoutMs?: number;
  /** Max reconnection attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  reconnectBaseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 60000) */
  reconnectMaxDelayMs?: number;
}

export interface ToolCallLog {
  tool: string;
  server: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface MCPManager {
  initialize(): Promise<void>;
  getTools(): ToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  shutdown(): Promise<void>;
  /** Get recent tool call logs */
  getToolCallLogs(): ToolCallLog[];
  /** Check if a specific server is connected */
  isServerConnected(name: string): boolean;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
const MAX_LOG_ENTRIES = 500;

// ============================================================
// Implementation
// ============================================================

export function createMCPManager(config: MCPConfig, options?: MCPManagerOptions): MCPManager {
  const servers: ConnectedServer[] = [];
  const toolRouting = new Map<string, number>();
  const toolCallLogs: ToolCallLog[] = [];

  const toolCallTimeoutMs = options?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  const reconnectBaseDelayMs = options?.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const reconnectMaxDelayMs = options?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;

  // Track active reconnection timers so we can clean up on shutdown
  const reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  let isShuttingDown = false;

  // ----------------------------------------------------------
  // Logging helper
  // ----------------------------------------------------------

  function recordToolCall(entry: ToolCallLog) {
    toolCallLogs.push(entry);
    // Keep bounded
    if (toolCallLogs.length > MAX_LOG_ENTRIES) {
      toolCallLogs.splice(0, toolCallLogs.length - MAX_LOG_ENTRIES);
    }
  }

  // ----------------------------------------------------------
  // Reconnection
  // ----------------------------------------------------------

  function scheduleReconnect(server: ConnectedServer, serverIndex: number) {
    if (isShuttingDown) return;
    if (server.reconnectAttempts >= maxReconnectAttempts) {
      log.error(`Server "${server.name}" exceeded max reconnect attempts (${maxReconnectAttempts}). Giving up.`);
      return;
    }

    const attempt = server.reconnectAttempts;
    // Exponential backoff with jitter
    const delay = Math.min(
      reconnectBaseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
      reconnectMaxDelayMs,
    );

    log.info(`Scheduling reconnect for "${server.name}" in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxReconnectAttempts})`);

    const timer = setTimeout(async () => {
      reconnectTimers.delete(timer);
      if (isShuttingDown) return;

      try {
        server.reconnectAttempts++;
        const reconnected = await connectServer(server.config);

        // Swap in the new client
        server.client = reconnected.client;
        server.tools = reconnected.tools;
        server.connected = true;
        server.reconnectAttempts = 0;

        // Re-register tools
        for (const tool of reconnected.tools) {
          toolRouting.set(tool.name, serverIndex);
        }

        // Re-attach disconnect handler
        attachDisconnectHandler(server, serverIndex);

        log.info(`Reconnected to "${server.name}" (${reconnected.tools.length} tools)`);
      } catch (err) {
        log.error(`Reconnect attempt ${server.reconnectAttempts} for "${server.name}" failed:`, err);
        server.connected = false;
        scheduleReconnect(server, serverIndex);
      }
    }, delay);

    reconnectTimers.add(timer);
  }

  function attachDisconnectHandler(server: ConnectedServer, serverIndex: number) {
    // The MCP SDK Client emits 'close' when the transport disconnects
    server.client.onclose = () => {
      if (isShuttingDown) return;
      log.warn(`Server "${server.name}" disconnected unexpectedly`);
      server.connected = false;
      scheduleReconnect(server, serverIndex);
    };
  }

  // ----------------------------------------------------------
  // Timeout wrapper
  // ----------------------------------------------------------

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool call "${label}" timed out after ${ms}ms`));
      }, ms);

      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  // ----------------------------------------------------------
  // Public interface
  // ----------------------------------------------------------

  return {
    async initialize() {
      for (const serverConfig of config.servers) {
        try {
          const connected = await connectServer(serverConfig);
          const serverIndex = servers.length;

          const entry: ConnectedServer = {
            ...connected,
            config: serverConfig,
            reconnectAttempts: 0,
            connected: true,
          };
          servers.push(entry);

          // Register tool routing
          for (const tool of connected.tools) {
            if (toolRouting.has(tool.name)) {
              log.warn(`Tool name conflict: "${tool.name}" exists in multiple servers. Using ${serverConfig.name}.`);
            }
            toolRouting.set(tool.name, serverIndex);
          }

          // Attach disconnect handler for auto-reconnect
          attachDisconnectHandler(entry, serverIndex);

          log.info(`Connected to MCP server "${serverConfig.name}" (${connected.tools.length} tools)`);
        } catch (err) {
          log.error(`Failed to connect to MCP server "${serverConfig.name}":`, err);
        }
      }
    },

    getTools(): ToolDefinition[] {
      return servers.filter(s => s.connected).flatMap(s => s.tools);
    },

    async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      const serverIndex = toolRouting.get(name);
      if (serverIndex === undefined) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const server = servers[serverIndex];

      if (!server.connected) {
        throw new Error(`Server "${server.name}" is disconnected. Tool "${name}" is unavailable.`);
      }

      const startTime = Date.now();
      log.info(`[tool-call] Executing "${name}" on server "${server.name}" | args: ${JSON.stringify(args).slice(0, 200)}`);

      try {
        const result = await withTimeout(
          server.client.callTool({ name, arguments: args }),
          toolCallTimeoutMs,
          name,
        );

        const durationMs = Date.now() - startTime;
        log.info(`[tool-call] "${name}" completed in ${durationMs}ms`);
        recordToolCall({ tool: name, server: server.name, startedAt: startTime, durationMs, success: true });

        // Extract text content from MCP response
        if (result.content && Array.isArray(result.content)) {
          const texts = result.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { type: string; text?: string }) => c.text ?? '');
          return texts.join('\n');
        }

        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error(`[tool-call] "${name}" failed after ${durationMs}ms: ${errorMsg}`);
        recordToolCall({ tool: name, server: server.name, startedAt: startTime, durationMs, success: false, error: errorMsg });
        throw err;
      }
    },

    async shutdown() {
      isShuttingDown = true;

      // Clear all pending reconnect timers
      for (const timer of reconnectTimers) {
        clearTimeout(timer);
      }
      reconnectTimers.clear();

      for (const server of servers) {
        try {
          await server.client.close();
          server.connected = false;
          log.info(`Disconnected from "${server.name}"`);
        } catch (err) {
          log.error(`Error disconnecting from "${server.name}":`, err);
        }
      }
    },

    getToolCallLogs(): ToolCallLog[] {
      return [...toolCallLogs];
    },

    isServerConnected(name: string): boolean {
      const server = servers.find(s => s.name === name);
      return server?.connected ?? false;
    },
  };
}

// ============================================================
// Server connection factory
// ============================================================

async function connectServer(config: MCPServerConfig): Promise<{ name: string; client: Client; tools: ToolDefinition[] }> {
  const client = new Client({
    name: 'new-agent',
    version: '0.1.0',
  });

  let transport;

  switch (config.transport) {
    case 'stdio': {
      if (!config.command) {
        throw new Error(`stdio transport requires "command" for server "${config.name}"`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...config.env } as Record<string, string>,
      });
      break;
    }
    case 'sse': {
      if (!config.url) {
        throw new Error(`SSE transport requires "url" for server "${config.name}"`);
      }
      const sseUrl = new URL(config.url);
      // Support Authorization headers for HTTP transports
      const sseOpts: Record<string, unknown> = {};
      if (config.headers) {
        sseOpts.requestInit = { headers: config.headers };
        sseOpts.eventSourceInit = {
          fetch: (url: string | URL, init?: RequestInit) =>
            fetch(url, {
              ...init,
              headers: { ...init?.headers as Record<string, string>, ...config.headers },
            }),
        };
      }
      transport = new SSEClientTransport(sseUrl, sseOpts);
      break;
    }
    case 'streamable-http': {
      if (!config.url) {
        throw new Error(`Streamable HTTP transport requires "url" for server "${config.name}"`);
      }
      const httpUrl = new URL(config.url);
      const httpOpts: Record<string, unknown> = {};
      if (config.headers) {
        httpOpts.requestInit = { headers: config.headers };
      }
      transport = new StreamableHTTPClientTransport(httpUrl, httpOpts);
      break;
    }
    default:
      throw new Error(`Unknown transport type: ${config.transport}`);
  }

  await client.connect(transport);

  // Discover tools
  const toolsResponse = await client.listTools();
  const tools: ToolDefinition[] = (toolsResponse.tools ?? []).map(t => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  return { name: config.name, client, tools };
}
