import type { MCPManager } from './manager.js';
import type { MCPConfig } from '../types/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('mcp:health');

// ============================================================
// Types
// ============================================================

export interface ServerHealthStatus {
  name: string;
  connected: boolean;
  lastCheckedAt: number;
  lastHealthyAt: number | null;
  consecutiveFailures: number;
}

export interface HealthCheckOptions {
  /** Interval between health checks in ms (default: 60000 = 1 min) */
  intervalMs?: number;
  /** Callback when a server goes unhealthy */
  onUnhealthy?: (status: ServerHealthStatus) => void;
  /** Callback when a server recovers */
  onRecovered?: (status: ServerHealthStatus) => void;
}

export interface MCPHealthChecker {
  /** Start periodic health checks */
  start(): void;
  /** Stop periodic health checks */
  stop(): void;
  /** Run a single health check cycle (all servers) */
  check(): Promise<ServerHealthStatus[]>;
  /** Get the latest status for all servers */
  getStatus(): ServerHealthStatus[];
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_INTERVAL_MS = 60_000;

// ============================================================
// Implementation
// ============================================================

export function createHealthChecker(
  manager: MCPManager,
  config: MCPConfig,
  options?: HealthCheckOptions,
): MCPHealthChecker {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Initialise status map from config
  const statusMap = new Map<string, ServerHealthStatus>();
  for (const server of config.servers) {
    statusMap.set(server.name, {
      name: server.name,
      connected: false,
      lastCheckedAt: 0,
      lastHealthyAt: null,
      consecutiveFailures: 0,
    });
  }

  async function checkAll(): Promise<ServerHealthStatus[]> {
    const now = Date.now();

    for (const server of config.servers) {
      const status = statusMap.get(server.name)!;
      const wasHealthy = status.connected;

      try {
        const connected = manager.isServerConnected(server.name);
        status.connected = connected;
        status.lastCheckedAt = now;

        if (connected) {
          status.lastHealthyAt = now;
          status.consecutiveFailures = 0;

          if (!wasHealthy) {
            log.info(`Server "${server.name}" recovered`);
            options?.onRecovered?.(status);
          }
        } else {
          status.consecutiveFailures++;
          log.warn(`Server "${server.name}" is unhealthy (consecutive failures: ${status.consecutiveFailures})`);
          options?.onUnhealthy?.({ ...status });
        }
      } catch (err) {
        status.connected = false;
        status.lastCheckedAt = now;
        status.consecutiveFailures++;
        log.error(`Health check error for "${server.name}":`, err);
        options?.onUnhealthy?.({ ...status });
      }
    }

    const allStatuses = [...statusMap.values()].map(s => ({ ...s }));
    const healthy = allStatuses.filter(s => s.connected).length;
    log.debug(`Health check complete: ${healthy}/${allStatuses.length} servers healthy`);

    return allStatuses;
  }

  return {
    start() {
      if (timer) return; // Already running
      log.info(`Starting health checks (interval: ${intervalMs}ms)`);
      // Run immediately, then on interval
      checkAll().catch(err => log.error('Initial health check failed:', err));
      timer = setInterval(() => {
        checkAll().catch(err => log.error('Periodic health check failed:', err));
      }, intervalMs);
      // Don't block process exit
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info('Health checks stopped');
      }
    },

    check: checkAll,

    getStatus(): ServerHealthStatus[] {
      return [...statusMap.values()].map(s => ({ ...s }));
    },
  };
}
