import { isDockerAvailable, runInDocker } from './docker.js';
import { runInSubprocess } from './subprocess.js';
import type { SandboxConfig, SandboxResult } from '../types/index.js';

export interface SandboxOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
  type?: 'docker' | 'subprocess';
  dockerImage?: string;
}

const DEFAULTS: Required<Omit<SandboxOptions, 'dockerImage'>> = {
  timeoutMs: 30_000,
  memoryLimitMb: 256,
  type: 'docker',
};

/**
 * Execute arbitrary code in an isolated sandbox.
 *
 * If `options.type` is `'docker'` (default) the code runs inside a
 * disposable container with network isolation, a read-only root FS,
 * and a configurable memory cap.
 *
 * If Docker is unavailable or `options.type` is `'subprocess'`, the code
 * runs directly via `node -e` / `python3 -c` with timeout + buffer limits
 * (less isolated but always available).
 */
export async function executeCode(
  code: string,
  language: 'javascript' | 'typescript' | 'python',
  options?: SandboxOptions,
): Promise<SandboxResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULTS.timeoutMs;
  const memoryLimitMb = options?.memoryLimitMb ?? DEFAULTS.memoryLimitMb;
  const requestedType = options?.type ?? DEFAULTS.type;

  // Decide execution backend
  let useDocker = requestedType === 'docker';
  if (useDocker) {
    useDocker = await isDockerAvailable();
  }

  if (useDocker) {
    return runInDocker(code, language, {
      timeoutMs,
      memoryLimitMb,
      dockerImage: options?.dockerImage,
    });
  }

  return runInSubprocess(code, language, {
    timeoutMs,
    maxBufferBytes: memoryLimitMb * 1024 * 1024,
  });
}
