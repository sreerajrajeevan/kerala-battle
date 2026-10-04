/**
 * Operator moderation commands (Task 10). No web admin dashboard exists yet;
 * these use the same database and business logic as the server.
 *
 *   npm run moderation:list-reports [--status open] [--limit 50]
 *   npm run moderation:report-status -- <reportId> <open|reviewed|dismissed|actioned>
 *   npm run moderation:suspend -- <playerId>
 *   npm run moderation:ban -- <playerId>
 *   npm run moderation:activate -- <playerId>
 *
 * The <playerId> is the stable player id (the competitive identity key).
 * Every mutating command prints exactly what it changed. Nothing here prints
 * secrets: reports show player ids and display names only.
 */

import { openDatabase } from '../competition/db.js';
import { getUserByPlayerId, setAccountStatus, isAccountStatus } from '../auth/users.js';
import { isReportStatus, listReports, setReportStatus } from '../moderation/reports.js';
import { upsertPlayer } from '../competition/store.js';

const dbPath = process.env.DB_PATH;
const db = openDatabase(
  dbPath ?? new URL('../../data/kerala-battle.db', import.meta.url).pathname,
);

function usage(): never {
  console.error(
    'Usage:\n' +
      '  moderation:list-reports [--status open] [--limit 50]\n' +
      '  moderation:report-status -- <reportId> <open|reviewed|dismissed|actioned>\n' +
      '  moderation:suspend -- <playerId>\n' +
      '  moderation:ban -- <playerId>\n' +
      '  moderation:activate -- <playerId>',
  );
  process.exit(1);
}

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const command = process.argv[2];

if (command === 'list-reports') {
  const statusRaw = flagValue('--status');
  let status: 'open' | 'reviewed' | 'dismissed' | 'actioned' | undefined;
  if (statusRaw) {
    if (!isReportStatus(statusRaw)) {
      console.error(`[moderation] invalid --status: ${statusRaw}`);
      process.exit(1);
    }
    status = statusRaw;
  }
  const limitRaw = flagValue('--limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  const reports = listReports(db, { status, limit: Number.isNaN(limit) ? 50 : limit });
  if (reports.length === 0) {
    console.log('[moderation] no reports found');
  } else {
    for (const report of reports) {
      const reporter = getUserByPlayerId(db, report.reporterPlayerId);
      const reported = getUserByPlayerId(db, report.reportedPlayerId);
      console.log(
        [
          `id=${report.id}`,
          `date=${new Date(report.createdAt).toISOString()}`,
          `reporter=${reporter?.displayName || '?'} (${report.reporterPlayerId})`,
          `reported=${reported?.displayName || '?'} (${report.reportedPlayerId})`,
          `reason=${report.reason}`,
          `context=${report.contextType ?? '-'}${report.contextId ? `:${report.contextId}` : ''}`,
          `status=${report.status}`,
          report.description ? `note=${JSON.stringify(report.description.slice(0, 120))}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }
} else if (command === 'report-status') {
  const reportId = process.argv[3];
  const statusRaw = process.argv[4];
  if (!reportId || !isReportStatus(statusRaw)) usage();
  const updated = setReportStatus(db, reportId, statusRaw);
  if (!updated) {
    console.error(`[moderation] no report with id ${reportId}`);
    process.exit(1);
  }
  console.log(`[moderation] report ${reportId} status -> ${updated.status}`);
} else if (command === 'suspend' || command === 'ban' || command === 'activate') {
  const playerId = process.argv[3];
  if (!playerId) usage();
  const target = command === 'activate' ? 'active' : command === 'suspend' ? 'suspended' : 'banned';
  if (!isAccountStatus(target)) usage();
  const before = getUserByPlayerId(db, playerId);
  if (!before) {
    console.error(`[moderation] no account with playerId ${playerId}`);
    process.exit(1);
  }
  const after = setAccountStatus(db, playerId, target);
  // Keep the lobby display row consistent; game systems read status from users.
  try {
    upsertPlayer(db, playerId, before.displayName, before.district ?? 'Kannur', Date.now());
  } catch {
    // Non-fatal: the status change is what matters.
  }
  console.log(
    `[moderation] account ${before.displayName} (${playerId}) status: ${before.status} -> ${after?.status}`,
  );
} else {
  usage();
}
