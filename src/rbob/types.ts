export interface LedgerEntry {
  id: number;
  contributor: string;
  pr_number: number | null;
  points: number;
  multiplier: number;
  reason: string;
  admin_signature: string | null;
  timestamp: number;
}

export interface BalanceResult {
  contributor: string;
  total_points: number;
  entries: number;
}

export interface LeaderboardEntry {
  rank: number;
  contributor: string;
  total_points: number;
  contributions: number;
}

export interface GrantParams {
  contributor: string;
  points: number;
  reason: string;
  pr_number?: number;
  multiplier?: number;
}

export interface TokenClaimExport {
  version: 1;
  exported_at: string;
  entries: Array<{
    contributor: string;
    pr_number: number | null;
    points: number;
    multiplier: number;
    reason: string;
    timestamp: string;
  }>;
  totals: Array<{
    contributor: string;
    total_points: number;
  }>;
}
