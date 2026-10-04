/**
 * Versioned SQLite DDL for the persistent competition system.
 *
 * Tables:
 * - players: one row per guest playerId (upserted on join; district follows
 *   the player's current district, never duplicated).
 * - matches: one row per legitimately completed ranked match. The PRIMARY KEY
 *   on match_id makes settlement idempotent: a second settlement attempt for
 *   the same matchId inserts nothing.
 * - weekly_player_stats: per-player aggregates for one competition week.
 * - daily_district_contribution: per-player district contribution for one
 *   competition day (drives the daily district cap).
 *
 * Historical district attribution: matches store the district each player
 * represented at match time (player_a_district / player_b_district), so a
 * later district switch never rewrites history.
 *
 * Match mode (v2): every match records how it was created. Direct challenges
 * are casual (no ranking points); only weekly-queue matches are ranked.
 * Rows written before v2 were ranked under the old direct-challenge model,
 * so they migrate as ranked/direct-challenge.
 */

export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        district TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        game_type TEXT NOT NULL,
        player_a_id TEXT NOT NULL,
        player_b_id TEXT NOT NULL,
        player_a_score INTEGER NOT NULL,
        player_b_score INTEGER NOT NULL,
        player_a_district TEXT NOT NULL,
        player_b_district TEXT NOT NULL,
        player_a_personal_points INTEGER NOT NULL,
        player_b_personal_points INTEGER NOT NULL,
        player_a_district_contribution INTEGER NOT NULL,
        player_b_district_contribution INTEGER NOT NULL,
        winner_player_id TEXT,
        completed_at INTEGER NOT NULL,
        competition_week_id TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS weekly_player_stats (
        competition_week_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        district TEXT NOT NULL,
        matches_played INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (competition_week_id, player_id)
      )`,
      `CREATE TABLE IF NOT EXISTS daily_district_contribution (
        competition_day_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        district TEXT NOT NULL,
        contribution INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (competition_day_id, player_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_matches_week ON matches (competition_week_id)`,
      `CREATE INDEX IF NOT EXISTS idx_weekly_stats_leaderboard
        ON weekly_player_stats (competition_week_id, points DESC, wins DESC)`,
    ],
  },
  {
    version: 2,
    statements: [
      // One row per competition week, created on first encounter. The
      // featured game is frozen at creation so history never shifts.
      `CREATE TABLE IF NOT EXISTS competition_weeks (
        competition_week_id TEXT PRIMARY KEY,
        featured_game_type TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      // How each match was created. Pre-v2 rows were ranked matches from
      // direct challenges under the old model; they keep those semantics.
      `ALTER TABLE matches ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'ranked'`,
      `ALTER TABLE matches ADD COLUMN match_source TEXT NOT NULL DEFAULT 'direct-challenge'`,
    ],
  },
  {
    version: 3,
    statements: [
      // Immutable weekly outcome: one row per finalized competition week.
      // Champions are snapshotted here so later profile/district changes and
      // future rotation changes can never rewrite history.
      `CREATE TABLE IF NOT EXISTS competition_week_results (
        competition_week_id TEXT PRIMARY KEY,
        featured_game_type TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        finalized_at INTEGER NOT NULL,
        weekly_master_player_id TEXT,
        weekly_master_display_name TEXT,
        weekly_master_district TEXT,
        weekly_master_points INTEGER NOT NULL DEFAULT 0,
        weekly_master_wins INTEGER NOT NULL DEFAULT 0,
        weekly_master_matches_played INTEGER NOT NULL DEFAULT 0,
        district_champion TEXT,
        district_champion_points INTEGER NOT NULL DEFAULT 0,
        district_champion_wins INTEGER NOT NULL DEFAULT 0,
        district_champion_active_players INTEGER NOT NULL DEFAULT 0
      )`,
      // Full snapshotted player standings for the week (rank order frozen).
      `CREATE TABLE IF NOT EXISTS competition_week_player_results (
        competition_week_id TEXT NOT NULL,
        final_rank INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        district TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        matches_played INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (competition_week_id, player_id)
      )`,
      // All 14 districts, even with zero points.
      `CREATE TABLE IF NOT EXISTS competition_week_district_results (
        competition_week_id TEXT NOT NULL,
        final_rank INTEGER NOT NULL,
        district TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        active_players INTEGER NOT NULL DEFAULT 0,
        points_per_active_player REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (competition_week_id, district)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_week_player_results_rank
        ON competition_week_player_results (competition_week_id, final_rank)`,
      `CREATE INDEX IF NOT EXISTS idx_week_district_results_rank
        ON competition_week_district_results (competition_week_id, final_rank)`,
    ],
  },
  {
    version: 4,
    statements: [
      // Stable accounts (Task 10). google_subject is the permanent external
      // identity (email can change); player_id stays the competitive identity
      // key used by every game system. google_subject is nullable so account
      // deletion can unlink the Google identity without breaking history.
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_subject TEXT UNIQUE,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL DEFAULT '',
        player_id TEXT NOT NULL UNIQUE,
        district TEXT,
        display_name_changed_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      )`,
      // Server-side sessions: only a peppered SHA-256 hash of the opaque
      // token is stored. The raw token lives only in the HttpOnly cookie.
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
      // Persistent blocks. Directional: blocker silences/is shielded from
      // blocked. No self-blocks; unique pair.
      `CREATE TABLE IF NOT EXISTS player_blocks (
        blocker_player_id TEXT NOT NULL,
        blocked_player_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_player_id, blocked_player_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON player_blocks (blocked_player_id)`,
      // Player reports for operator review. No web dashboard yet; the
      // moderation CLI reads these.
      `CREATE TABLE IF NOT EXISTS player_reports (
        id TEXT PRIMARY KEY,
        reporter_player_id TEXT NOT NULL,
        reported_player_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        context_type TEXT,
        context_id TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reports_status ON player_reports (status, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_reports_reported ON player_reports (reported_player_id, created_at)`,
    ],
  },
];
