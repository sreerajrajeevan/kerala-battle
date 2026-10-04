/**
 * Server-authoritative display-name validation (Task 10).
 *
 * Rules: NFC-normalized, trimmed, 2-20 chars, Unicode letters/numbers/spaces
 * only (no control characters), and not invisible-only. There is no
 * hard-coded profanity dictionary by design; player reports are the
 * enforcement mechanism.
 */

// Invisible-only characters stripped before the emptiness check. The set is
// deliberately narrow: zero-width joiners remain meaningful inside scripts
// like Malayalam, so they are allowed within otherwise-visible names.
// U+200B zero-width space, U+200C ZWNJ, U+200D ZWJ, U+2060 word joiner,
// U+FEFF byte-order mark.
const INVISIBLE_ONLY = new RegExp(
  `[${['200B', '200C', '200D', '2060', 'FEFF']
    .map((hex) => String.fromCharCode(parseInt(hex, 16)))
    .join('')}]`,
  'g',
);

export interface DisplayNameCheck {
  ok: boolean;
  /** The canonical stored form (normalized + trimmed). */
  normalized: string;
  reason?: string;
}

export function checkDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string') {
    return { ok: false, normalized: '', reason: 'not a string' };
  }
  const normalized = raw.normalize('NFC').trim();
  const visible = normalized.replace(INVISIBLE_ONLY, '');
  if (visible.length < 2) {
    return { ok: false, normalized, reason: 'too short or invisible-only' };
  }
  if (visible.length > 20) {
    return { ok: false, normalized, reason: 'too long' };
  }
  // Allow letters, numbers, spaces, and ZWJ/ZWNJ only: rejects control
  // characters, bidi overrides, and other format characters. ZWJ/ZWNJ
  // survive here when mixed with visible text (needed for scripts like
  // Malayalam); invisible-only names were already rejected above.
  // The escapes are U+200C (ZWNJ) and U+200D (ZWJ).
  if (!/^[\p{L}\p{N} \u200C\u200D]+$/u.test(normalized)) {
    return { ok: false, normalized, reason: 'invalid characters' };
  }
  return { ok: true, normalized };
}

/** Rename cooldown: one display-name change per 7 days. */
export const DISPLAY_NAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a rename is allowed right now. Initial setup (no previous change
 * timestamp) never counts as a rename.
 */
export function renameAllowed(
  displayNameChangedAt: number | null | undefined,
  nowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  if (displayNameChangedAt == null) return { allowed: true, retryAfterMs: 0 };
  const elapsed = nowMs - displayNameChangedAt;
  if (elapsed >= DISPLAY_NAME_COOLDOWN_MS) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: DISPLAY_NAME_COOLDOWN_MS - elapsed };
}
