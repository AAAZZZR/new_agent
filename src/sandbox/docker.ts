import { execFile, spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxResult } from '../types/index.js';

const IMAGES: Record<string, string> = {
  javascript: 'node:22-slim',
  typescript: 'node:22-slim',
  python: 'python:3.12-slim',
};

const COMMANDS: Record<string, (file: string) => string[]> = {
  javascript: (f) => ['node', f],
  typescript: (f) => ['npx', '--yes', 'tsx', f],
  python: (f) => ['python3', f],
};

const EXTENSIONS: Record<string, string> = {
  javascript: '.js',
  typescript: '.ts',
  python: '.py',
};

/**
 * Check whether Docker is available on this host.
 */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

export interface DockerRunOptions {
  timeoutMs: number;
  memoryLimitMb: number;
  dockerImage?: string;
}

/**
 * Execute code inside a Docker container.
 *
 * Strategy: write code to a temp file on the host, bind-mount it into the
 * container as read-only, then run the appropriate interpreter.
 */
export async function runInDocker(
  code: string,
  language: 'javascript' | 'typescript' | 'python',
  options: DockerRunOptions,
): Promise<SandboxResult> {
  const ext = EXTENSIONS[language];
  const tempFile = join(tmpdir(), `sandbox-${randomUUID()}${ext}`);
  const containerPath = `/tmp/code${ext}`;

  await writeFile(tempFile, code, 'utf-8');

  const image = options.dockerImage ?? IMAGES[language];
  const cmd = COMMANDS[language](containerPath);

  const args: string[] = [
    'run',
    '--rm',
    '--network', 'none',
    '--read-only',
    '--memory', `${options.memoryLimitMb}m`,
    '--tmpfs', '/tmp:rw,noexec,size=64m',
    '-v', `${tempFile}:${containerPath}:ro`,
    image,
    ...cmd,
  ];

  return new Promise<SandboxResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, options.timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // best-effort cleanup
      unlink(tempFile).catch(() => {});
      resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlink(tempFile).catch(() => {});
      resolve({ stdout, stderr: stderr + err.message, exitCode: 1, timedOut });
    });
  });
}
