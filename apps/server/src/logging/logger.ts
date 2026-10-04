/**
 * Task 11: lightweight structured logger.
 *
 * JSON lines on stdout, one object per line:
 *   {"ts":"...","level":"info","event":"socket.connected","requestId":"...","playerId":"..."}
 *
 * Rules:
 * - Never pass secrets here: no ID tokens, session cookies, LiveKit tokens,
 *   Google subjects, emails, or API secrets. The logger does not redact; the
 *   caller is responsible for only sending safe fields.
 * - `event` is a stable machine-readable name; human detail goes in other
 *   fields.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const MIN_LEVEL = LEVELS[configuredLevel()];

export interface LogFields {
  event: string;
  requestId?: string;
  playerId?: string;
  matchId?: string;
  competitionWeekId?: string;
  gameType?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, fields: LogFields): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...fields,
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (fields: LogFields) => write('debug', fields),
  info: (fields: LogFields) => write('info', fields),
  warn: (fields: LogFields) => write('warn', fields),
  /** For caught errors: pass the error object separately, never its secrets. */
  error: (fields: LogFields, error?: unknown) =>
    write('error', {
      ...fields,
      ...(error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : error !== undefined
          ? { errorValue: String(error) }
          : {}),
    }),
};
