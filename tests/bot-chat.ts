/**
 * Direct chat tester - tests the full pipeline bypassing Telegram
 * Imports the same modules the bot uses and simulates conversations
 */
import 'dotenv/config';
import { loadConfig, resolveEnvVars } from '../src/config/index.js';
import { createSessionManager } from '../src/session/index.js';
import { createLLMRouter } from '../src/llm/index.js';

const config = resolveEnvVars(loadConfig());
const sessions = createSessionManager(config);
const llm = createLLMRouter(config.llm);

const CHAT_ID = 88888; // fake test chat
const OWNER_ID = 8274521225;

async function chat(userMessage: string): Promise<string> {
  // Get or create session (simulate owner)
  sessions.getOrCreate(CHAT_ID, { senderId: OWNER_ID, senderName: 'Tester', isOwner: true });
  sessions.addMessage(CHAT_ID, { role: 'user', content: userMessage, timestamp: Date.now() });

  const messages = sessions.getMessages(CHAT_ID);
  const response = await llm.chat({
    model: config.llm.defaultModel,
    messages,
    maxTokens: 500,
  });

  sessions.addMessage(CHAT_ID, { role: 'assistant', content: response.content, timestamp: Date.now() });
  return response.content;
}

async function main() {
  const tests = [
    { input: '你好！你是誰？', expect: null, name: 'Basic greeting' },
    { input: '現在幾點？', expect: /\d{1,2}:\d{2}/, name: 'Time query (should use get_time tool)' },
    { input: '幫我算 123 * 456', expect: /56088/, name: 'Math (should use calculate tool)' },
    { input: '列出 workspace 裡的檔案', expect: /test\.txt/, name: 'List files (should use filesystem tool)' },
    { input: '幫我存一個筆記，key 是 "greeting"，內容是 "hello from test"', expect: /save|筆記|greeting/i, name: 'Save note' },
    { input: '讀取筆記 greeting', expect: /hello from test/i, name: 'Get note' },
  ];

  console.log('🤖 Bot Chat Tests\n' + '='.repeat(50));

  for (const t of tests) {
    console.log(`\n📨 User: ${t.input}`);
    try {
      const reply = await chat(t.input);
      console.log(`🤖 Bot: ${reply.slice(0, 200)}`);
      if (t.expect) {
        const pass = t.expect.test(reply);
        console.log(pass ? `✅ ${t.name}` : `❌ ${t.name} (expected ${t.expect})`);
      } else {
        console.log(`✅ ${t.name} (got response)`);
      }
    } catch (e: any) {
      console.log(`❌ ${t.name}: ${e.message}`);
    }
  }

  // Test guest access
  console.log('\n\n🔒 Guest Access Test\n' + '='.repeat(50));
  const GUEST_CHAT = 77777;
  sessions.getOrCreate(GUEST_CHAT, { senderId: 99999, senderName: 'Guest', isOwner: false });
  sessions.addMessage(GUEST_CHAT, { role: 'user', content: 'Hi, who are you?', timestamp: Date.now() });
  const guestMsgs = sessions.getMessages(GUEST_CHAT);
  const guestReply = await llm.chat({ model: config.llm.defaultModel, messages: guestMsgs, maxTokens: 200 });
  console.log(`📨 Guest: Hi, who are you?`);
  console.log(`🤖 Bot: ${guestReply.content.slice(0, 200)}`);
  console.log(`✅ Guest gets response`);
}

main().catch(e => console.error('Fatal:', e));
