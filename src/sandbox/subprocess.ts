import { spawn } from 'node:child_process';
import type { SandboxResult } from '../types/index.js';

const INTERPRETERS: Record<string, { cmd: string; flag: string }> = {
  javascript: { cmd: 'node', flag: '-e' },
  typescript: { cmd: 'node', flag: '-e' },   // TS via tsx would need npx; keep simple
  python:     { cmd: 'python3', flag: '-c' },
};

export interface SubprocessRunOptions {
  timeoutMs: number;
  maxBufferBytes?: number;
}

/**
 * Execute code in a local subprocess.
 *
 * Less isolated than Docker but works everywhere Node is installed.
 */
export async function runInSubprocess(
  code: string,
  language: 'javascript' | 'typescript' | 'python',
  options: SubprocessRunOptions,
): Promise<SandboxResult> {
  const interp = INTERPRETERS[language];
  const maxBuffer = options.maxBufferBytes ?? 5 * 1024 * 1024; // 5 MB default

  return new Promise<SandboxResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const proc = spawn(interp.cmd, [interp.flag, code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, options.timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) {
        stdout += chunk.toString();
      } else if (!timedOut) {
        // exceeded buffer — kill
        proc.kill('SIGKILL');
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) {
        stderr += chunk.toString();
      }
    });

    proc.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: 1, timedOut });
    });
  });
}
