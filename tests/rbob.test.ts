import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RbobLedger } from '../src/rbob/index.js';
import { generateSigningKeyPair, toHex } from '../src/crypto/index.js';

describe('RbobLedger', () => {
  let ledger: RbobLedger;
  let tmpDir: string;
  let adminKeys: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rbob-test-'));
    ledger = new RbobLedger(join(tmpDir, 'rbob.db'));
    adminKeys = generateSigningKeyPair();
  });

  afterEach(() => {
    ledger.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('grant', () => {
    it('records points with signature', () => {
      const entry = ledger.grant(
        { contributor: 'alice', points: 500, reason: 'feat: add auth module', pr_number: 42 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      expect(entry.contributor).toBe('alice');
      expect(entry.points).toBe(500);
      expect(entry.pr_number).toBe(42);
      expect(entry.multiplier).toBe(1.0);
      expect(entry.reason).toBe('feat: add auth module');
      expect(entry.admin_signature).toBeTruthy();
      expect(entry.id).toBeGreaterThan(0);
    });

    it('applies Genesis 5x multiplier', () => {
      const entry = ledger.grant(
        { contributor: 'bob', points: 300, reason: 'Genesis contributor', multiplier: 5 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      expect(entry.points).toBe(1500); // 300 * 5
      expect(entry.multiplier).toBe(5);
    });

    it('applies fractional multiplier for decay', () => {
      const entry = ledger.grant(
        { contributor: 'carol', points: 400, reason: 'mid-genesis', multiplier: 3.2 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      expect(entry.points).toBe(1280); // 400 * 3.2
      expect(entry.multiplier).toBe(3.2);
    });

    it('signature is verifiable', () => {
      const entry = ledger.grant(
        { contributor: 'dave', points: 100, reason: 'bugfix' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      expect(ledger.verifyEntry(entry, adminKeys.publicKey)).toBe(true);
    });

    it('rejects tampered entries', () => {
      const entry = ledger.grant(
        { contributor: 'eve', points: 100, reason: 'bugfix' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      // Tamper with points
      const tampered = { ...entry, points: 9999 };
      expect(ledger.verifyEntry(tampered, adminKeys.publicKey)).toBe(false);
    });

    it('rejects wrong admin key', () => {
      const entry = ledger.grant(
        { contributor: 'frank', points: 100, reason: 'test' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const otherKeys = generateSigningKeyPair();
      expect(ledger.verifyEntry(entry, otherKeys.publicKey)).toBe(false);
    });

    it('rejects zero points', () => {
      expect(() =>
        ledger.grant(
          { contributor: 'alice', points: 0, reason: 'free' },
          adminKeys.secretKey,
          adminKeys.publicKey,
        ),
      ).toThrow('Points must be positive');
    });

    it('rejects negative points', () => {
      expect(() =>
        ledger.grant(
          { contributor: 'alice', points: -10, reason: 'hack' },
          adminKeys.secretKey,
          adminKeys.publicKey,
        ),
      ).toThrow('Points must be positive');
    });

    it('rejects empty contributor', () => {
      expect(() =>
        ledger.grant(
          { contributor: '', points: 100, reason: 'test' },
          adminKeys.secretKey,
          adminKeys.publicKey,
        ),
      ).toThrow('Contributor is required');
    });

    it('rejects empty reason', () => {
      expect(() =>
        ledger.grant(
          { contributor: 'alice', points: 100, reason: '' },
          adminKeys.secretKey,
          adminKeys.publicKey,
        ),
      ).toThrow('Reason is required');
    });
  });

  describe('balance', () => {
    it('returns zero for unknown contributor', () => {
      const result = ledger.balance('nobody');
      expect(result.total_points).toBe(0);
      expect(result.entries).toBe(0);
    });

    it('sums multiple grants', () => {
      ledger.grant(
        { contributor: 'alice', points: 200, reason: 'PR #1', pr_number: 1 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'alice', points: 300, reason: 'PR #2', pr_number: 2 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const result = ledger.balance('alice');
      expect(result.total_points).toBe(500);
      expect(result.entries).toBe(2);
    });

    it('includes multiplied points in balance', () => {
      ledger.grant(
        { contributor: 'alice', points: 100, reason: 'genesis', multiplier: 5 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const result = ledger.balance('alice');
      expect(result.total_points).toBe(500);
    });
  });

  describe('leaderboard', () => {
    it('returns empty for no data', () => {
      const entries = ledger.leaderboard();
      expect(entries).toHaveLength(0);
    });

    it('ranks by total points descending', () => {
      ledger.grant(
        { contributor: 'alice', points: 300, reason: 'PR' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'bob', points: 500, reason: 'PR' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'carol', points: 100, reason: 'PR' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const board = ledger.leaderboard();
      expect(board).toHaveLength(3);
      expect(board[0]!.contributor).toBe('bob');
      expect(board[0]!.rank).toBe(1);
      expect(board[0]!.total_points).toBe(500);
      expect(board[1]!.contributor).toBe('alice');
      expect(board[1]!.rank).toBe(2);
      expect(board[2]!.contributor).toBe('carol');
      expect(board[2]!.rank).toBe(3);
    });

    it('aggregates multiple grants per contributor', () => {
      ledger.grant(
        { contributor: 'alice', points: 200, reason: 'PR #1' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'alice', points: 300, reason: 'PR #2' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'bob', points: 400, reason: 'PR #1' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const board = ledger.leaderboard();
      expect(board[0]!.contributor).toBe('alice');
      expect(board[0]!.total_points).toBe(500);
      expect(board[0]!.contributions).toBe(2);
      expect(board[1]!.contributor).toBe('bob');
      expect(board[1]!.total_points).toBe(400);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 25; i++) {
        ledger.grant(
          { contributor: `user${i}`, points: (25 - i) * 10, reason: 'test' },
          adminKeys.secretKey,
          adminKeys.publicKey,
        );
      }

      const board = ledger.leaderboard(5);
      expect(board).toHaveLength(5);
      expect(board[0]!.contributor).toBe('user0');
      expect(board[4]!.contributor).toBe('user4');
    });

    it('genesis multiplier affects ranking', () => {
      // alice: 100 base * 5x = 500
      ledger.grant(
        { contributor: 'alice', points: 100, reason: 'genesis', multiplier: 5 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      // bob: 400 base * 1x = 400
      ledger.grant(
        { contributor: 'bob', points: 400, reason: 'late' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const board = ledger.leaderboard();
      expect(board[0]!.contributor).toBe('alice');
      expect(board[0]!.total_points).toBe(500);
      expect(board[1]!.contributor).toBe('bob');
      expect(board[1]!.total_points).toBe(400);
    });
  });

  describe('exportJSON', () => {
    it('exports empty ledger', () => {
      const data = ledger.exportJSON();
      expect(data.version).toBe(1);
      expect(data.entries).toHaveLength(0);
      expect(data.totals).toHaveLength(0);
      expect(data.exported_at).toBeTruthy();
    });

    it('exports entries with ISO timestamps', () => {
      ledger.grant(
        { contributor: 'alice', points: 500, reason: 'feat', pr_number: 10 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const data = ledger.exportJSON();
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]!.contributor).toBe('alice');
      expect(data.entries[0]!.points).toBe(500);
      expect(data.entries[0]!.pr_number).toBe(10);
      expect(data.entries[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('includes totals per contributor', () => {
      ledger.grant(
        { contributor: 'alice', points: 300, reason: 'PR #1' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'alice', points: 200, reason: 'PR #2' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );
      ledger.grant(
        { contributor: 'bob', points: 100, reason: 'PR #1' },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const data = ledger.exportJSON();
      expect(data.totals).toHaveLength(2);
      expect(data.totals[0]!.contributor).toBe('alice');
      expect(data.totals[0]!.total_points).toBe(500);
      expect(data.totals[1]!.contributor).toBe('bob');
      expect(data.totals[1]!.total_points).toBe(100);
    });

    it('matches token claim format', () => {
      ledger.grant(
        { contributor: 'alice', points: 100, reason: 'test', multiplier: 5, pr_number: 1 },
        adminKeys.secretKey,
        adminKeys.publicKey,
      );

      const data = ledger.exportJSON();
      // Verify structure matches future on-chain claim format
      expect(data).toHaveProperty('version', 1);
      expect(data).toHaveProperty('exported_at');
      expect(data).toHaveProperty('entries');
      expect(data).toHaveProperty('totals');

      const entry = data.entries[0]!;
      expect(entry).toHaveProperty('contributor');
      expect(entry).toHaveProperty('pr_number');
      expect(entry).toHaveProperty('points');
      expect(entry).toHaveProperty('multiplier');
      expect(entry).toHaveProperty('reason');
      expect(entry).toHaveProperty('timestamp');
      // No raw DB fields leak through
      expect(entry).not.toHaveProperty('id');
      expect(entry).not.toHaveProperty('admin_signature');
    });
  });
});
