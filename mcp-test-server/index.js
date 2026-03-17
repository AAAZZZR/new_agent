#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "test-tools",
  version: "1.0.0",
});

// Simple calculator tool
server.tool("calculate", "Perform basic math calculations", {
  expression: z.string().describe("Math expression to evaluate, e.g. '2 + 3 * 4'"),
}, async ({ expression }) => {
  try {
    // Safe math eval (only numbers and operators)
    const sanitized = expression.replace(/[^0-9+\-*/().% ]/g, "");
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return { content: [{ type: "text", text: `${expression} = ${result}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

// Get current time tool
server.tool("get_time", "Get the current date and time", {}, async () => {
  const now = new Date();
  return {
    content: [{ type: "text", text: `Current time: ${now.toISOString()} (UTC)` }],
  };
});

// Random number tool
server.tool("random_number", "Generate a random number", {
  min: z.number().default(1).describe("Minimum value"),
  max: z.number().default(100).describe("Maximum value"),
}, async ({ min, max }) => {
  const num = Math.floor(Math.random() * (max - min + 1)) + min;
  return { content: [{ type: "text", text: `Random number between ${min} and ${max}: ${num}` }] };
});

// Note storage (in-memory)
const notes = new Map();

server.tool("save_note", "Save a note with a key", {
  key: z.string().describe("Note key/name"),
  content: z.string().describe("Note content"),
}, async ({ key, content }) => {
  notes.set(key, content);
  return { content: [{ type: "text", text: `Note "${key}" saved.` }] };
});

server.tool("get_note", "Retrieve a saved note", {
  key: z.string().describe("Note key/name"),
}, async ({ key }) => {
  const note = notes.get(key);
  if (!note) return { content: [{ type: "text", text: `Note "${key}" not found.` }] };
  return { content: [{ type: "text", text: `Note "${key}": ${note}` }] };
});

server.tool("list_notes", "List all saved notes", {}, async () => {
  if (notes.size === 0) return { content: [{ type: "text", text: "No notes saved." }] };
  const list = [...notes.entries()].map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return { content: [{ type: "text", text: `Saved notes:\n${list}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
