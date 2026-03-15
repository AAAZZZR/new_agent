import 'dotenv/config';
import { loadConfig, resolveEnvVars } from './config/index.js';
import { createGateway } from './gateway/index.js';
import { createSessionManager } from './session/index.js';
import { createLLMRouter } from './llm/index.js';
import { createMCPManager } from './mcp/index.js';
import { Logger } from './utils/logger.js';

const log = new Logger('main');

async function main() {
  log.info('Starting agent...');

  // 1. Load config (immutable after this point)
  const rawConfig = loadConfig();
  const config = resolveEnvVars(rawConfig);
  log.info('Config loaded');

  // 2. Initialize LLM Router
  const llm = createLLMRouter(config.llm);
  log.info(`LLM Router ready (default: ${config.llm.defaultProvider}/${config.llm.defaultModel})`);

  // 3. Initialize MCP Manager (optional — skip if servers fail)
  const mcp = createMCPManager(config.mcp);
  try {
    await mcp.initialize();
    const tools = mcp.getTools();
    log.info(`MCP ready (${tools.length} tools from ${config.mcp.servers.length} servers)`);
  } catch (err) {
    log.warn('MCP initialization failed, continuing without tools:', err);
  }

  // 4. Initialize Session Manager
  const sessions = createSessionManager(config);
  log.info('Session Manager ready');

  // 5. Start Telegram Gateway
  const gateway = createGateway({
    config,
    llm,
    mcp,
    sessions,
  });
  await gateway.start();
  log.info('Telegram Gateway started');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    await gateway.stop();
    await mcp.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
