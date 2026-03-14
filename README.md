# New Agent

A lightweight, secure AI agent framework with native MCP support.

## Features

- **Native MCP** — Direct tool calling via MCP SDK, no shell exec
- **Self-immutable** — Agent cannot modify its own config or prompts
- **Code sandbox** — Agent-written code runs in isolated environments
- **Provider agnostic** — Supports Anthropic, OpenAI, and more
- **Smart context** — Compaction, hybrid memory search, temporal decay

## Quick Start

```bash
# Install dependencies
npm install

# Copy and edit config
cp .env.example .env
# Edit .env with your API keys

# Edit agent config
# vi config/agent.json

# Run in development mode
npm run dev
```

## Configuration

All config lives in `config/agent.json`. The agent can read but never modify this file.

### Required Environment Variables

- `TELEGRAM_BOT_TOKEN` — Your Telegram bot token from @BotFather
- `ANTHROPIC_API_KEY` — Anthropic API key (default provider)
- `OWNER_ID` — Your Telegram user ID (for owner permissions)

### Optional

- `OPENAI_API_KEY` — OpenAI API key (fallback provider)
- `EMBEDDING_API_KEY` — For memory search embeddings

## Architecture

```
Telegram → Gateway → LLM Router → MCP Client → MCP Servers
                  ↘ Session Manager
                  ↘ Memory Search
                  ↘ Sandbox Executor
```

## Project Structure

```
src/
├── index.ts          # Entry point
├── gateway/          # Telegram bot (grammY)
├── llm/              # LLM provider router
│   ├── router.ts
│   └── providers/    # Anthropic, OpenAI, etc.
├── mcp/              # Native MCP client
├── session/          # Session management
├── memory/           # Context & memory search (WIP)
├── sandbox/          # Code execution sandbox (WIP)
├── config/           # Config loader (read-only)
├── types/            # TypeScript types
└── utils/            # Logger, helpers
```

## Commands

- `/start` — Start the bot
- `/reset` — Clear current session

## License

MIT
