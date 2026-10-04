/**
 * Task 11: graceful beta UI states for maintenance and server restarts.
 * No stack traces, no technical detail — just what the player needs to know.
 */

import type { JSX } from 'react';

export function MaintenanceOverlay(): JSX.Element {
  return (
    <div className="maintenance-overlay" role="alert" aria-live="assertive">
      <div className="maintenance-card">
        <h1>Kerala Battle</h1>
        <p className="maintenance-title">Temporarily under maintenance</p>
        <p className="maintenance-detail">
          We&apos;re making things better. Please check back soon — your
          profile, district, and leaderboard progress are safe.
        </p>
      </div>
    </div>
  );
}

export function RestartToast(): JSX.Element {
  return (
    <div className="toast restart-toast" role="status">
      Server is restarting… reconnecting.
    </div>
  );
}
