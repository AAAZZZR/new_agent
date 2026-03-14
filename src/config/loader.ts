import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import type { AppConfig } from '../types/index.js';

const CONFIG_PATH = resolve(process.cwd(), 'config', 'agent.json');

let configHash: string | null = null;
let cachedConfig: AppConfig | null = null;

/**
 * Load and validate config from JSON file.
 * Config is immutable at runtime — agent cannot modify it.
 */
export function loadConfig(path?: string): AppConfig {
  const configFile = path ?? CONFIG_PATH;

  if (!existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}`);
  }

  const raw = readFileSync(configFile, 'utf-8');
  const parsed = JSON.parse(raw) as AppConfig;

  // Compute hash for integrity check
  const hash = createHash('sha256').update(raw).digest('hex');

  if (configHash === null) {
    configHash = hash;
  }

  cachedConfig = Object.freeze(structuredClone(parsed)) as AppConfig;
  return cachedConfig;
}

/**
 * Get the current config (cached).
 * Throws if config hasn't been loaded yet.
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

/**
 * Check if config file has been tampered with since startup.
 * Returns true if integrity is intact.
 */
export function checkConfigIntegrity(path?: string): boolean {
  if (!configHash) return true; // Never loaded, nothing to check

  const configFile = path ?? CONFIG_PATH;
  if (!existsSync(configFile)) return false;

  const raw = readFileSync(configFile, 'utf-8');
  const currentHash = createHash('sha256').update(raw).digest('hex');

  return currentHash === configHash;
}

/**
 * Resolve environment variables in config values.
 * Replaces ${ENV_VAR} patterns with actual env values.
 */
export function resolveEnvVars(config: AppConfig): AppConfig {
  const raw = JSON.stringify(config);
  const resolved = raw.replace(/\$\{(\w+)\}/g, (_, key) => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Environment variable ${key} is required but not set`);
    }
    return value;
  });
  return JSON.parse(resolved) as AppConfig;
}
