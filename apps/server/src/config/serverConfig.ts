/**
 * Task 11: centralized server configuration + production validation.
 *
 * Environment variables:
 *   PORT                  HTTP port (default 3001)
 *   NODE_ENV              "production" enables fail-fast validation
 *   DATA_DIR              persistent directory for the SQLite file
 *                         (default: <repo>/apps/server/data, /data in Docker)
 *   DB_PATH               explicit database file path (overrides DATA_DIR;
 *                         kept for dev/test workflows)
 *   WEB_URL / WEB_URLS    credentialed web origins, comma-separated
 *   MAINTENANCE_MODE      "true" shows a maintenance notice and blocks new play
 *   INTERNAL_METRICS_TOKEN  bearer token protecting GET /internal/metrics
 *   SERVE_STATIC          "true"/"false" (default: true in production)
 *   APP_VERSION / GIT_COMMIT  build metadata for /api/version
 *   LOG_LEVEL             debug|info|warn|error
 *
 * Production (NODE_ENV=production) fails fast on critical security
 * misconfiguration instead of silently falling back to insecure defaults.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logging/logger.js';
import { databasePath } from '../competition/db.js';

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  dataDir: string;
  dbPath: string | null; // explicit DB_PATH override, or null
  webOrigins: string[];
  maintenanceMode: boolean;
  internalMetricsToken: string | null;
  serveStatic: boolean;
  appVersion: string;
  gitCommit: string;
}

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Fatal configuration errors: printed loudly, then the process exits. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const port = Number(env.PORT) || 3001;
  const dbPath = env.DB_PATH?.trim() || null;
  // Authoritative resolution lives in competition/db.ts (DB_PATH override,
  // then DATA_DIR, then the dev default). Shown here for startup logging.
  const dataDir = dirname(databasePath());
  const webOrigins = (env.WEB_URLS || env.WEB_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  const maintenanceMode = env.MAINTENANCE_MODE === 'true';
  const internalMetricsToken = env.INTERNAL_METRICS_TOKEN?.trim() || null;
  const serveStatic =
    env.SERVE_STATIC !== undefined ? env.SERVE_STATIC === 'true' : isProduction;

  const fatal: string[] = [];
  if (isProduction) {
    // Critical security misconfiguration must fail fast, never silently
    // fall back to insecure defaults.
    if (!env.SESSION_COOKIE_SECRET?.trim()) {
      fatal.push('SESSION_COOKIE_SECRET is required in production.');
    }
    if (env.AUTH_REQUIRED === 'true' && !env.GOOGLE_CLIENT_ID?.trim()) {
      fatal.push('GOOGLE_CLIENT_ID is required in production when AUTH_REQUIRED=true.');
    }
    const livekitVars = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].filter(
      (k) => env[k]?.trim(),
    );
    if (livekitVars.length > 0 && livekitVars.length < 3) {
      fatal.push(
        `Incomplete LiveKit config in production (set: ${livekitVars.join(', ')}). ` +
          'Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together, or none.',
      );
    }
    if (webOrigins.some((o) => o.includes('localhost') || o.includes('127.0.0.1'))) {
      fatal.push(
        'WEB_URL/WEB_URLS must be explicit public origins in production ' +
          `(got: ${webOrigins.join(', ')}). localhost origins are dev-only.`,
      );
    }
    if (!internalMetricsToken) {
      logger.warn({
        event: 'config.metrics_unprotected',
        detail: 'INTERNAL_METRICS_TOKEN not set: /internal/metrics will return 404.',
      });
    }
  }

  if (fatal.length > 0) {
    for (const message of fatal) {
      logger.error({ event: 'config.fatal', detail: message });
    }
    throw new ConfigError(fatal.join(' '));
  }

  return {
    port,
    nodeEnv,
    isProduction,
    dataDir,
    dbPath,
    webOrigins,
    maintenanceMode,
    internalMetricsToken,
    serveStatic,
    appVersion: env.APP_VERSION?.trim() || readPackageVersion(),
    gitCommit: env.GIT_COMMIT?.trim() || 'unknown',
  };
}
