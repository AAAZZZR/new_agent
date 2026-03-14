import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConfig, MCPServerConfig, ToolDefinition } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('mcp');

interface ConnectedServer {
  name: string;
  client: Client;
  tools: ToolDefinition[];
}

export interface MCPManager {
  initialize(): Promise<void>;
  getTools(): ToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  shutdown(): Promise<void>;
}

export function createMCPManager(config: MCPConfig): MCPManager {
  const servers: ConnectedServer[] = [];
  // Map tool name → server index for routing
  const toolRouting = new Map<string, number>();

  return {
    async initialize() {
      for (const serverConfig of config.servers) {
        try {
          const connected = await connectServer(serverConfig);
          const serverIndex = servers.length;
          servers.push(connected);

          // Register tool routing
          for (const tool of connected.tools) {
            if (toolRouting.has(tool.name)) {
              log.warn(`Tool name conflict: "${tool.name}" exists in multiple servers. Using ${serverConfig.name}.`);
            }
            toolRouting.set(tool.name, serverIndex);
          }

          log.info(`Connected to MCP server "${serverConfig.name}" (${connected.tools.length} tools)`);
        } catch (err) {
          log.error(`Failed to connect to MCP server "${serverConfig.name}":`, err);
        }
      }
    },

    getTools(): ToolDefinition[] {
      return servers.flatMap(s => s.tools);
    },

    async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      const serverIndex = toolRouting.get(name);
      if (serverIndex === undefined) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const server = servers[serverIndex];
      log.info(`Executing tool "${name}" on server "${server.name}"`);

      const result = await server.client.callTool({
        name,
        arguments: args,
      });

      // Extract text content from MCP response
      if (result.content && Array.isArray(result.content)) {
        const texts = result.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { type: string; text?: string }) => c.text ?? '');
        return texts.join('\n');
      }

      return result;
    },

    async shutdown() {
      for (const server of servers) {
        try {
          await server.client.close();
          log.info(`Disconnected from "${server.name}"`);
        } catch (err) {
          log.error(`Error disconnecting from "${server.name}":`, err);
        }
      }
    },
  };
}

async function connectServer(config: MCPServerConfig): Promise<ConnectedServer> {
  const client = new Client({
    name: 'new-agent',
    version: '0.1.0',
  });

  // Create transport based on type
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
      transport = new SSEClientTransport(new URL(config.url));
      break;
    }
    case 'streamable-http': {
      if (!config.url) {
        throw new Error(`Streamable HTTP transport requires "url" for server "${config.name}"`);
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url));
      break;
    }
    default:
      throw new Error(`Unknown transport type: ${config.transport}`);
  }

  // Connect
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
