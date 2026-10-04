/**
 * Task 11: HTTP middleware — request IDs, security headers, maintenance gate.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logging/logger.js';
import { metrics } from '../metrics/metrics.js';

const REQUEST_ID_HEADER = 'x-request-id';
// Only reuse caller-supplied IDs that look safe (no log injection).
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/** Assign a correlation ID, echo it back in the response header. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID().slice(0, 8);
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

/** Time HTTP requests; count errors. Skips /health noise in counters only. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const route = req.path;
    metrics.observe('http.request.durationMs', durationMs);
    metrics.inc('http.requests.total');
    if (res.statusCode >= 500) {
      metrics.inc('http.errors.total');
      logger.warn({
        event: 'http.server_error',
        requestId: req.requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
      });
    } else {
      logger.debug({
        event: 'http.request',
        requestId: req.requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
      });
    }
  });
  next();
}

/**
 * Baseline web security headers. CSP is applied only when serving the
 * production SPA (it must allow Google Identity Services, LiveKit/WebRTC,
 * and Socket.IO; the values below were chosen for exactly those).
 */
export function securityHeadersMiddleware(options: { contentSecurityPolicy: boolean }) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Microphone for LiveKit voice; nothing else needs privileged features.
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    if (options.contentSecurityPolicy) {
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          // Google Identity Services button + library.
          "script-src 'self' https://accounts.google.com",
          "frame-src https://accounts.google.com",
          // Socket.IO + LiveKit signaling (wss) + Google token endpoints.
          "connect-src 'self' https://accounts.google.com wss: ws:",
          "img-src 'self' data: https:",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "media-src 'self' blob:",
          "worker-src 'self' blob:",
        ].join('; '),
      );
    }
    next();
  };
}

const MAINTENANCE_PUBLIC_PATHS = new Set(['/health', '/ready', '/api/version']);

/**
 * When MAINTENANCE_MODE=true, API routes (except health/readiness/version)
 * answer 503 so users see the maintenance notice instead of half-working
 * features. Socket.IO and queue/match creation check the flag separately.
 */
export function maintenanceMiddleware(isMaintenanceMode: () => boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isMaintenanceMode()) return next();
    if (MAINTENANCE_PUBLIC_PATHS.has(req.path)) return next();
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/internal/')) return next();
    metrics.inc('http.maintenance_rejections');
    res.status(503).json({
      error: 'maintenance',
      message: 'Kerala Battle is temporarily under maintenance. Please check back soon.',
    });
  };
}
