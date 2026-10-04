import { useState } from 'react';
import {
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type CreateReportRequest,
  type ReportContextType,
  type ReportReason,
} from '@kerala-battle/shared';
import { useSafety } from '../safety/safetyContext';

/**
 * Report Player dialog (Task 10). Reasons are fixed; the description is
 * optional and capped at 500 characters. Context (lobby / match / voice) is
 * supplied by the caller from server-known data where available.
 */

interface ReportDialogProps {
  reportedName: string;
  reportedPlayerId: string;
  contextType?: ReportContextType;
  contextId?: string;
  onClose: () => void;
}

const MAX_DESCRIPTION = 500;

export default function ReportDialog({
  reportedName,
  reportedPlayerId,
  contextType,
  contextId,
  onClose,
}: ReportDialogProps) {
  const safety = useSafety();
  const [reason, setReason] = useState<ReportReason>('harassment');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (): Promise<void> => {
    if (description.length > MAX_DESCRIPTION) {
      setError(`Description must be under ${MAX_DESCRIPTION} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const input: CreateReportRequest = {
      reportedPlayerId,
      reason,
      description: description.trim(),
    };
    if (contextType) input.contextType = contextType;
    if (contextId) input.contextId = contextId;
    const result = await safety.reportPlayer(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not submit report.');
      return;
    }
    setDone(true);
  };

  return (
    <div className="card-overlay" onClick={onClose}>
      <section className="player-card" onClick={(e) => e.stopPropagation()}>
        {!done ? (
          <>
            <h3>Report {reportedName}</h3>
            <p className="muted-note">Reports are reviewed by the game operator.</p>
            <label className="field-label">
              Reason
              <select
                className="text-input"
                value={reason}
                onChange={(e) => setReason(e.target.value as ReportReason)}
                disabled={busy}
              >
                {REPORT_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {REPORT_REASON_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Details (optional, {MAX_DESCRIPTION - description.length} left)
              <textarea
                className="text-input"
                value={description}
                maxLength={MAX_DESCRIPTION}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
                placeholder="What happened?"
              />
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="primary-btn"
              onClick={() => void submit()}
              disabled={busy}
            >
              Submit report
            </button>
            <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <h3>Report submitted</h3>
            <p className="muted-note">Thanks. The game operator will review it.</p>
            <button type="button" className="primary-btn" onClick={onClose}>
              Done
            </button>
          </>
        )}
      </section>
    </div>
  );
}
