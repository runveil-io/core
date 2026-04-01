import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sign, verify, toHex, fromHex } from '../crypto/index.js';
import type {
  LedgerEntry,
  BalanceResult,
  LeaderboardEntry,
  GrantParams,
  TokenClaimExport,
} from './types.js';

export class RbobLedger {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rbob_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contributor TEXT NOT NULL,
        pr_number INTEGER,
        points INTEGER NOT NULL,
        multiplier REAL NOT NULL DEFAULT 1.0,
        reason TEXT NOT NULL,
        admin_signature TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rbob_contributor ON rbob_ledger(contributor);
      CREATE INDEX IF NOT EXISTS idx_rbob_timestamp ON rbob_ledger(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rbob_pr ON rbob_ledger(pr_number);
    `);
  }

  /**
   * Grant points to a contributor. Requires admin wallet signature.
   */
  grant(
    params: GrantParams,
    adminSecretKey: Uint8Array,
    adminPublicKey: Uint8Array,
  ): LedgerEntry {
    const { contributor, points, reason, pr_number, multiplier } = params;

    if (points <= 0) throw new Error('Points must be positive');
    if (!contributor) throw new Error('Contributor is required');
    if (!reason) throw new Error('Reason is required');

    const effectiveMultiplier = multiplier ?? 1.0;
    const effectivePoints = Math.round(points * effectiveMultiplier);
    const timestamp = Date.now();

    // Sign the grant: contributor|points|multiplier|reason|timestamp
    const message = `${contributor}|${effectivePoints}|${effectiveMultiplier}|${reason}|${timestamp}`;
    const signature = sign(
      new TextEncoder().encode(message),
      adminSecretKey,
    );
    const signatureHex = toHex(signature);

    const stmt = this.db.prepare(`
      INSERT INTO rbob_ledger (contributor, pr_number, points, multiplier, reason, admin_signature, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      contributor,
      pr_number ?? null,
      effectivePoints,
      effectiveMultiplier,
      reason,
      signatureHex,
      timestamp,
    );

    return {
      id: result.lastInsertRowid as number,
      contributor,
      pr_number: pr_number ?? null,
      points: effectivePoints,
      multiplier: effectiveMultiplier,
      reason,
      admin_signature: signatureHex,
      timestamp,
    };
  }

  /**
   * Verify a ledger entry's admin signature.
   */
  verifyEntry(entry: LedgerEntry, adminPublicKey: Uint8Array): boolean {
    if (!entry.admin_signature) return false;
    const message = `${entry.contributor}|${entry.points}|${entry.multiplier}|${entry.reason}|${entry.timestamp}`;
    return verify(
      new TextEncoder().encode(message),
      fromHex(entry.admin_signature),
      adminPublicKey,
    );
  }

  /**
   * Get total balance for a contributor.
   */
  balance(contributor: string): BalanceResult {
    const row = this.db.prepare(`
      SELECT
        contributor,
        COALESCE(SUM(points), 0) as total_points,
        COUNT(*) as entries
      FROM rbob_ledger
      WHERE contributor = ?
      GROUP BY contributor
    `).get(contributor) as { contributor: string; total_points: number; entries: number } | undefined;

    return row ?? { contributor, total_points: 0, entries: 0 };
  }

  /**
   * Get top N contributors by total points.
   */
  leaderboard(limit: number = 20): LeaderboardEntry[] {
    const rows = this.db.prepare(`
      SELECT
        contributor,
        SUM(points) as total_points,
        COUNT(*) as contributions
      FROM rbob_ledger
      GROUP BY contributor
      ORDER BY total_points DESC
      LIMIT ?
    `).all(limit) as Array<{ contributor: string; total_points: number; contributions: number }>;

    return rows.map((row, i) => ({
      rank: i + 1,
      contributor: row.contributor,
      total_points: row.total_points,
      contributions: row.contributions,
    }));
  }

  /**
   * Get all entries for a contributor.
   */
  history(contributor: string): LedgerEntry[] {
    return this.db.prepare(`
      SELECT * FROM rbob_ledger
      WHERE contributor = ?
      ORDER BY timestamp DESC
    `).all(contributor) as LedgerEntry[];
  }

  /**
   * Export entire ledger as JSON for future on-chain migration.
   */
  exportJSON(): TokenClaimExport {
    const entries = this.db.prepare(`
      SELECT * FROM rbob_ledger ORDER BY timestamp ASC
    `).all() as LedgerEntry[];

    const totals = this.db.prepare(`
      SELECT contributor, SUM(points) as total_points
      FROM rbob_ledger
      GROUP BY contributor
      ORDER BY total_points DESC
    `).all() as Array<{ contributor: string; total_points: number }>;

    return {
      version: 1,
      exported_at: new Date().toISOString(),
      entries: entries.map((e) => ({
        contributor: e.contributor,
        pr_number: e.pr_number,
        points: e.points,
        multiplier: e.multiplier,
        reason: e.reason,
        timestamp: new Date(e.timestamp).toISOString(),
      })),
      totals,
    };
  }

  close(): void {
    this.db.close();
  }
}
