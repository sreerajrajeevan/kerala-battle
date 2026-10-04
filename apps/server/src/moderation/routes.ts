/**
 * Safety HTTP routes (Task 10).
 *
 * /api/blocks  — persistent blocking (list / block / unblock).
 * /api/reports — player reporting (creation only; review is via the CLI).
 *
 * Every route requires a valid session for an active account. Reporter and
 * blocker identities always come from the session, never the request body.
 */

import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { BlockEntry, CreateReportRequest, CreateReportResponse } from '@kerala-battle/shared';
import { authenticateRequest } from '../auth/routes.js';
import { blockPlayer, getBlockList, unblockPlayer } from './blocks.js';
import { createReport } from './reports.js';
import { RATE_LIMIT_RULES, type RateLimiter } from '../rate-limit/limiter.js';
import { requireSameOrigin } from '../auth/routes.js';
import { metrics } from '../metrics/metrics.js';
import { logger } from '../logging/logger.js';

export interface ModerationRouteDeps {
  db: DatabaseSync;
  limiter: RateLimiter;
  pepper: string;
  allowedOrigins: string[];
}

function requireActiveAccount(deps: ModerationRouteDeps, req: Request, res: Response) {
  const auth = authenticateRequest(deps.db, req, deps.pepper);
  if (!auth) {
    res.status(401).json({ error: 'not authenticated' });
    return null;
  }
  if (auth.user.status !== 'active') {
    res.status(403).json({ error: 'This account is unavailable.' });
    return null;
  }
  return auth;
}

export function buildSafetyRouter(deps: ModerationRouteDeps): Router {
  const router = Router();
  const csrf = requireSameOrigin(deps.allowedOrigins);

  router.get('/blocks', (req, res) => {
    const auth = requireActiveAccount(deps, req, res);
    if (!auth) return;
    const blocks: BlockEntry[] = getBlockList(deps.db, auth.user.playerId);
    res.json({ blocks });
  });

  router.post('/blocks', csrf, (req, res) => {
    const auth = requireActiveAccount(deps, req, res);
    if (!auth) return;
    const blockedPlayerId =
      typeof (req.body as { blockedPlayerId?: unknown } | null)?.blockedPlayerId === 'string'
        ? (req.body as { blockedPlayerId: string }).blockedPlayerId
        : null;
    if (!blockedPlayerId) {
      res.status(400).json({ error: 'blockedPlayerId required' });
      return;
    }
    const hit = deps.limiter.check(`blocks:${auth.user.playerId}`, RATE_LIMIT_RULES.blocks);
    if (!hit.ok) {
      res.status(429).json({ error: 'rate limited', retryAfterMs: hit.retryAfterMs });
      return;
    }
    const result = blockPlayer(deps.db, auth.user.playerId, blockedPlayerId);
    if (!result.ok) {
      if (result.reason === 'self-block') {
        res.status(400).json({ error: 'cannot block yourself' });
      } else {
        res.status(409).json({ error: 'already blocked' });
      }
      return;
    }
    res.status(201).json({ ok: true, createdAt: result.createdAt });
  });

  router.delete('/blocks/:playerId', csrf, (req, res) => {
    const auth = requireActiveAccount(deps, req, res);
    if (!auth) return;
    const removed = unblockPlayer(deps.db, auth.user.playerId, req.params.playerId);
    res.json({ ok: true, removed });
  });

  router.post('/reports', csrf, (req, res) => {
    const auth = requireActiveAccount(deps, req, res);
    if (!auth) return;
    const hit = deps.limiter.check(`reports:${auth.user.playerId}`, RATE_LIMIT_RULES.reports);
    if (!hit.ok) {
      res.status(429).json({ error: 'report limit reached', retryAfterMs: hit.retryAfterMs });
      return;
    }
    const body = (req.body ?? {}) as Partial<CreateReportRequest>;
    const result = createReport(deps.db, {
      reporterPlayerId: auth.user.playerId,
      reportedPlayerId: typeof body.reportedPlayerId === 'string' ? body.reportedPlayerId : '',
      reason: body.reason,
      description: body.description,
      contextType: body.contextType,
      contextId: body.contextId,
    });
    if (!result.ok) {
      const status =
        result.reason === 'duplicate'
          ? 409
          : result.reason === 'description-too-long'
            ? 400
            : 400;
      const message =
        result.reason === 'self-report'
          ? 'cannot report yourself'
          : result.reason === 'invalid-reason'
            ? 'invalid report reason'
            : result.reason === 'description-too-long'
              ? 'description too long (max 500 characters)'
              : result.reason === 'duplicate'
                ? 'duplicate report'
                : 'invalid report context';
      res.status(status).json({ error: message });
      return;
    }
    const payload: CreateReportResponse = { ok: true, reportId: result.report.id };
    metrics.inc('reports.submitted');
    logger.info({
      event: 'report.submitted',
      reportId: result.report.id,
      reason: result.report.reason,
      requestId: req.requestId,
    });
    res.status(201).json(payload);
  });

  return router;
}
