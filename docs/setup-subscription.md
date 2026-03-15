# 使用 Claude 訂閱方案

你可以用 Claude Pro/Max 訂閱帳號來跑這個 agent，不需要額外付 API 費用。

## 前置條件

1. 有 Claude Pro 或 Max 訂閱
2. 已安裝 Claude Code CLI 並登入
3. 已安裝 Node.js 20+

## 步驟

### 1. 安裝 claude-max-api-proxy

```bash
npm install -g claude-max-api-proxy
```

### 2. 確認 Claude CLI 已登入

```bash
claude --version
# 如果沒登入，執行：
claude login
```

### 3. 啟動 proxy

```bash
claude-max-api
# 預設在 http://localhost:3456
```

### 4. 設定 agent config

`config/agent.json` 裡的 `llm` 區塊：

```json
{
  "llm": {
    "defaultProvider": "claude-subscription",
    "defaultModel": "claude-sonnet-4",
    "providers": {
      "claude-subscription": {
        "apiKey": "not-needed",
        "baseUrl": "http://localhost:3456/v1",
        "models": ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"]
      }
    }
  }
}
```

### 5. 啟動 agent

```bash
npm run dev
```

## 切換到 API Key

如果你想改用付費 API（例如需要 prompt caching 或更高速率）：

```json
{
  "llm": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-20250514",
    "providers": {
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "models": ["claude-sonnet-4-20250514"]
      }
    }
  }
}
```

## 同時保留兩個

config 裡可以同時列 `claude-subscription` 和 `anthropic`，訂閱優先、API 做 fallback：

```json
{
  "defaultProvider": "claude-subscription",
  "fallbackProvider": "anthropic"
}
```

這樣訂閱 proxy 掛了時，自動切到 API key。

## 注意事項

- proxy 需要持續運行，建議設成 systemd service 或 launchd
- 訂閱方案有速率限制（依你的方案不同），高頻使用可能被限速
- Anthropic 政策可能變更，使用前請確認最新條款
