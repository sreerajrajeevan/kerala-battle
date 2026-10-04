/**
 * Player reporting (Task 10).
 *
 * Creation + storage only; there is no web moderation dashboard yet. The
 * operator CLI reads these rows. Protections:
 * - no self-reports;
 * - reason must be one of REPORT_REASONS;
 * - description max 500 chars (rejected when longer);
 * - context_type must be a known kind; ranked-match context_id must be a
 *   real match the reporter participated in (no forged privileged metadata);
 * - identical report within 10 minutes is deduplicated;
 * - 10 reports/hour/reporter enforced by the caller via the rate limiter.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isReportContextType,
  isReportReason,
  type ReportContextType,
  type ReportReason,
} from '@kerala-battle/shared';

/** Max report description length. Longer descriptions are rejected (400). */
export const MAX_REPORT_DESCRIPTION_LENGTH = 500;

/** Duplicate window: identical report within this long is rejected. */
export const REPORT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

export type ReportStatus = 'open' | 'reviewed' | 'dismissed' | 'actioned';

const VALID_REPORT_STATUSES: readonly string[] = ['open', 'reviewed', 'dismissed', 'actioned'];

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && (VALID_REPORT_STATUSES as readonly string[]).includes(value);
}

export interface ReportRecord {
  id: string;
  reporterPlayerId: string;
  reportedPlayerId: string;
  reason: ReportReason;
  description: string;
  contextType: ReportContextType | null;
  contextId: string | null;
  createdAt: number;
  status: ReportStatus;
}

interface ReportRow {
  id: string;
  reporter_player_id: string;
  reported_player_id: string;
  reason: string;
  description: string;
  context_type: string | null;
  context_id: string | null;
  created_at: number;
  status: string;
}

type SqlValue = string | number | bigint | null | undefined;

function rowRecord(row: Record<string, unknown>): ReportRow {
  const value = (key: string): SqlValue => {
    const v: unknown = row[key];
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v == null
      ? (v as SqlValue)
      : null;
  };
  const str = (key: string): string => {
    const v = value(key);
    return typeof v === 'string' ? v : '';
  };
  const strOrNull = (key: string): string | null => {
    const v = value(key);
    return typeof v === 'string' ? v : null;
  };
  const num = (key: string): number => {
    const v = value(key);
    return typeof v === 'number' ? v : Number(v ?? 0);
  };
  return {
    id: str('id'),
    reporter_player_id: str('reporter_player_id'),
    reported_player_id: str('reported_player_id'),
    reason: str('reason'),
    description: str('description'),
    context_type: strOrNull('context_type'),
    context_id: strOrNull('context_id'),
    created_at: num('created_at'),
    status: str('status'),
  };
}

function toReportRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    reporterPlayerId: row.reporter_player_id,
    reportedPlayerId: row.reported_player_id,
    reason: isReportReason(row.reason) ? row.reason : 'other',
    description: row.description,
    contextType: isReportContextType(row.context_type) ? row.context_type : null,
    contextId: row.context_id,
    createdAt: row.created_at,
    status: isReportStatus(row.status) ? row.status : 'open',
  };
}

export interface CreateReportInput {
  reporterPlayerId: string;
  reportedPlayerId: string;
  reason: unknown;
  description?: unknown;
  contextType?: unknown;
  contextId?: unknown;
}

export type CreateReportResult =
  | { ok: true; report: ReportRecord }
  | { ok: false; reason: 'self-report' | 'invalid-reason' | 'description-too-long' | 'invalid-context' | 'duplicate' };

/**
 * Validates and stores a report. Match-context validation: a ranked-match
 * context_id must be a real settled match the reporter played in; other
 * contexts accept the id as opaque operator context (untrusted).
 */
export function createReport(
  db: DatabaseSync,
  input: CreateReportInput,
  nowMs: number = Date.now(),
): CreateReportResult {
  const { reporterPlayerId, reportedPlayerId } = input;
  if (
    typeof reporterPlayerId !== 'string' ||
    typeof reportedPlayerId !== 'string' ||
    reporterPlayerId.length === 0 ||
    reportedPlayerId.length === 0
  ) {
    return { ok: false, reason: 'invalid-context' };
  }
  if (reporterPlayerId === reportedPlayerId) return { ok: false, reason: 'self-report' };
  if (!isReportReason(input.reason)) return { ok: false, reason: 'invalid-reason' };

  let description = '';
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') return { ok: false, reason: 'invalid-context' };
    if (input.description.length > MAX_REPORT_DESCRIPTION_LENGTH) {
      return { ok: false, reason: 'description-too-long' };
    }
    description = input.description;
  }

  let contextType: ReportContextType | null = null;
  let contextId: string | null = null;
  if (input.contextType !== undefined) {
    if (!isReportContextType(input.contextType)) return { ok: false, reason: 'invalid-context' };
    contextType = input.contextType;
    if (input.contextId !== undefined) {
      if (typeof input.contextId !== 'string' || input.contextId.length > 128) {
        return { ok: false, reason: 'invalid-context' };
      }
      contextId = input.contextId;
    }
    if (contextType === 'ranked-match') {
      // Ranked matches are persisted; the reporter must have played in it.
      const match = db
        .prepare('SELECT player_a_id, player_b_id FROM matches WHERE match_id = ?')
        .get(contextId ?? '') as { player_a_id: string; player_b_id: string } | undefined;
      if (!match || (match.player_a_id !== reporterPlayerId && match.player_b_id !== reporterPlayerId)) {
        return { ok: false, reason: 'invalid-context' };
      }
    }
  } else if (input.contextId !== undefined) {
    return { ok: false, reason: 'invalid-context' };
  }

  // Deduplicate identical reports in a short window (spam protection).
  const since = nowMs - REPORT_DEDUP_WINDOW_MS;
  const duplicate = db
    .prepare(
      `SELECT 1 FROM player_reports
       WHERE reporter_player_id = ? AND reported_player_id = ? AND reason = ?
         AND COALESCE(context_type, '') = COALESCE(?, '')
         AND COALESCE(context_id, '') = COALESCE(?, '')
         AND created_at >= ?`,
    )
    .get(
      reporterPlayerId,
      reportedPlayerId,
      input.reason,
      contextType,
      contextId,
      since,
    );
  if (duplicate) return { ok: false, reason: 'duplicate' };

  const id = `rep_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO player_reports
       (id, reporter_player_id, reported_player_id, reason, description,
        context_type, context_id, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(id, reporterPlayerId, reportedPlayerId, input.reason, description, contextType, contextId, nowMs);
  const inserted = db.prepare('SELECT * FROM player_reports WHERE id = ?').get(id);
  if (!inserted) throw new Error('[moderation] failed to read back report');
  return { ok: true, report: toReportRecord(rowRecord(inserted)) };
}

/** Operator listing, newest first. Filtered by status when given. */
export function listReports(
  db: DatabaseSync,
  options: { status?: ReportStatus; limit?: number } = {},
): ReportRecord[] {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  let rawRows: Array<Record<string, unknown>>;
  if (options.status) {
    rawRows = db
      .prepare('SELECT * FROM player_reports WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(options.status, limit);
  } else {
    rawRows = db
      .prepare('SELECT * FROM player_reports ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }
  return rawRows.map((raw) => toReportRecord(rowRecord(raw)));
}

/** Operator action: move a report to a new status. Returns the updated row. */
export function setReportStatus(
  db: DatabaseSync,
  reportId: string,
  status: ReportStatus,
): ReportRecord | null {
  db.prepare('UPDATE player_reports SET status = ? WHERE id = ?').run(status, reportId);
  const raw = db.prepare('SELECT * FROM player_reports WHERE id = ?').get(reportId);
  return raw ? toReportRecord(rowRecord(raw)) : null;
}
