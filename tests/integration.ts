/**
 * Integration tests — test each module independently without Telegram
 */
import 'dotenv/config';
import { loadConfig, resolveEnvVars } from '../src/config/index.js';
import { createSessionManager } from '../src/session/index.js';
import { createMCPManager } from '../src/mcp/index.js';
import { createLLMRouter } from '../src/llm/index.js';

const PASS = '✅';
const FAIL = '❌';
let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`${PASS} ${name}`);
    passed++;
  } else {
    console.log(`${FAIL} ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function testConfig() {
  console.log('\n=== Config ===');
  try {
    const raw = loadConfig();
    assert('Config loads', !!raw);
    assert('Has telegram config', !!raw.telegram);
    assert('Has llm config', !!raw.llm);
    assert('Has mcp config', !!raw.mcp);
    assert('Has auth config', !!raw.auth);
    
    const config = resolveEnvVars(raw);
    assert('Env vars resolved', config.telegram.botToken.length > 10);
    assert('Owner ID set', config.auth.ownerId === 8274521225);
    return config;
  } catch (e: any) {
    assert('Config loads', false, e.message);
    return null;
  }
}

async function testSession(config: any) {
  console.log('\n=== Session Manager ===');
  const sessions = createSessionManager(config);
  
  const session = sessions.getOrCreate(12345, { senderId: 99, senderName: 'Test', isOwner: false });
  assert('Session created', !!session);
  assert('Session has ID', !!session.id);
  assert('Session has system message', session.messages.length === 1);
  assert('System message role is system', session.messages[0].role === 'system');
  
  sessions.addMessage(12345, { role: 'user', content: 'hello', timestamp: Date.now() });
  const msgs = sessions.getMessages(12345);
  assert('Message added', msgs.length === 2);
  assert('User message content correct', msgs[1].content === 'hello');
  
  sessions.clear(12345);
  const cleared = sessions.getSession(12345);
  assert('Session cleared', cleared === undefined);
}

async function testMCP(config: any) {
  console.log('\n=== MCP Client ===');
  const mcp = createMCPManager(config.mcp);
  
  try {
    await mcp.initialize();
    const tools = mcp.getTools();
    assert('MCP initialized', true);
    assert('Tools discovered', tools.length > 0, `Found ${tools.length} tools`);
    
    // Check test-tools server
    const testTools = tools.filter(t => ['calculate', 'get_time', 'random_number', 'save_note', 'get_note', 'list_notes'].includes(t.name));
    assert('Test tools found', testTools.length === 6, `Found ${testTools.length}/6`);
    
    // Check filesystem tools
    const fsTools = tools.filter(t => t.name.includes('file') || t.name.includes('directory') || t.name.includes('search'));
    assert('Filesystem tools found', fsTools.length > 0, `Found ${fsTools.length}`);
    
    // Test tool execution: calculate
    console.log('\n--- Tool Execution ---');
    const calcResult = await mcp.executeTool('calculate', { expression: '2 + 3 * 4' });
    assert('Calculate tool works', String(calcResult).includes('14'), `Result: ${calcResult}`);
    
    // Test tool execution: get_time
    const timeResult = await mcp.executeTool('get_time', {});
    assert('Get time tool works', String(timeResult).includes('202'), `Result: ${timeResult}`);
    
    // Test tool execution: random_number
    const randResult = await mcp.executeTool('random_number', { min: 1, max: 10 });
    assert('Random number tool works', String(randResult).includes('Random'), `Result: ${randResult}`);
    
    // Test notes flow
    await mcp.executeTool('save_note', { key: 'test', content: 'hello world' });
    const noteResult = await mcp.executeTool('get_note', { key: 'test' });
    assert('Save+get note works', String(noteResult).includes('hello world'), `Result: ${noteResult}`);
    
    const listResult = await mcp.executeTool('list_notes', {});
    assert('List notes works', String(listResult).includes('test'), `Result: ${listResult}`);
    
    // Test filesystem: list directory
    const lsResult = await mcp.executeTool('list_directory', { path: '/home/ubuntu/new_agent/workspace' });
    assert('List directory works', String(lsResult).includes('test.txt'), `Result: ${String(lsResult).slice(0, 100)}`);
    
    // Test filesystem: read file
    const readResult = await mcp.executeTool('read_file', { path: '/home/ubuntu/new_agent/workspace/test.txt' });
    assert('Read file works', String(readResult).includes('Hello from workspace'), `Result: ${readResult}`);
    
    await mcp.shutdown();
    assert('MCP shutdown clean', true);
  } catch (e: any) {
    assert('MCP test', false, e.message);
  }
}

async function testLLM(config: any) {
  console.log('\n=== LLM Router (via proxy) ===');
  const llm = createLLMRouter(config.llm);
  
  try {
    const response = await llm.chat({
      model: config.llm.defaultModel,
      messages: [
        { role: 'system', content: 'Reply in exactly 5 words.', timestamp: Date.now() },
        { role: 'user', content: 'Say hello', timestamp: Date.now() },
      ],
      maxTokens: 50,
    });
    
    assert('LLM responds', !!response.content, `Content: ${response.content}`);
    assert('Has usage info', response.usage.totalTokens > 0, `Tokens: ${response.usage.totalTokens}`);
    assert('Finish reason is stop', response.finishReason === 'stop');
  } catch (e: any) {
    assert('LLM responds', false, e.message);
  }
}

async function testEndToEnd(config: any) {
  console.log('\n=== End-to-End (LLM + MCP) ===');
  const llm = createLLMRouter(config.llm);
  const mcp = createMCPManager(config.mcp);
  const sessions = createSessionManager(config);
  
  try {
    await mcp.initialize();
    const tools = mcp.getTools();
    
    // Simulate: user asks "what time is it?"
    const session = sessions.getOrCreate(99999, { senderId: 1, senderName: 'Test', isOwner: true });
    sessions.addMessage(99999, { role: 'user', content: 'What is 15 * 23?', timestamp: Date.now() });
    
    // Note: proxy doesn't support tool calling, so LLM will just answer directly
    const response = await llm.chat({
      model: config.llm.defaultModel,
      messages: sessions.getMessages(99999),
      // Don't pass tools since proxy ignores them
    });
    
    assert('E2E: LLM answers math question', response.content.includes('345'), `Answer: ${response.content}`);
    
    await mcp.shutdown();
  } catch (e: any) {
    assert('E2E test', false, e.message);
  }
}

// Run all tests
async function main() {
  console.log('🧪 Integration Tests\n' + '='.repeat(50));
  
  const config = await testConfig();
  if (!config) { console.log('\nConfig failed, skipping remaining tests'); process.exit(1); }
  
  await testSession(config);
  await testMCP(config);
  await testLLM(config);
  await testEndToEnd(config);
  
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
