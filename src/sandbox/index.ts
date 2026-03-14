/**
 * Sandbox module — run untrusted code in an isolated environment.
 *
 * Usage:
 *   import { createSandbox } from './sandbox/index.js';
 *   const sandbox = await createSandbox();
 *   const result  = await sandbox.execute('console.log("hi")', 'javascript');
 */

import { isDockerAvailable } from './docker.js';
import { executeCode, type SandboxOptions } from './executor.js';
import type { SandboxConfig, SandboxResult } from '../types/index.js';

export type { SandboxOptions } from './executor.js';
export { executeCode } from './executor.js';
export { isDockerAvailable } from './docker.js';

export interface Sandbox {
  /** The resolved backend type after auto-detection. */
  type: 'docker' | 'subprocess';
  /** Execute code and return captured output. */
  execute: (
    code: string,
    language: 'javascript' | 'typescript' | 'python',
    options?: SandboxOptions,
  ) => Promise<SandboxResult>;
}

/**
 * Create a Sandbox instance.
 *
 * When `config.type` is omitted or set to `'docker'` the factory probes for
 * a running Docker daemon and transparently falls back to subprocess mode if
 * Docker is not available.
 */
export async function createSandbox(config?: Partial<SandboxConfig>): Promise<Sandbox> {
  const preferDocker = (config?.type ?? 'docker') === 'docker';
  const dockerOk = preferDocker ? await isDockerAvailable() : false;
  const resolvedType: 'docker' | 'subprocess' = dockerOk ? 'docker' : 'subprocess';

  const defaultOpts: SandboxOptions = {
    type: resolvedType,
    timeoutMs: config?.timeoutMs ?? 30_000,
    memoryLimitMb: config?.memoryLimitMb ?? 256,
    dockerImage: config?.dockerImage,
  };

  return {
    type: resolvedType,
    execute: (code, language, overrides) =>
      executeCode(code, language, { ...defaultOpts, ...overrides }),
  };
}
