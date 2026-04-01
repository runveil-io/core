/**
 * Consumer Budget Guard
 *
 * Enforces per-request cost and duration limits so a single
 * completion can never silently run up an unbounded bill.
 */

import { calculateCostByModel, DEFAULT_PRICE_TABLE } from '../metering/index.js';
import { createLogger } from '../logger.js';
import type { NormalizedUsage, CostBreakdown } from '../metering/types.js';

const log = createLogger('budget');

// ── Public interfaces ────────────────────────────────────────────

export interface BudgetConfig {
  /** Maximum cost in USDC for this request (default $1.00) */
  max_cost_usdc: number;
  /** Maximum wall-clock time in ms (default 120 000 = 2 min) */
  max_duration_ms?: number;
}

export interface BudgetCheckResult {
  exceeded: boolean;
  used_usdc: number;
  limit_usdc: number;
  reason: string;
}

export interface BudgetSummary {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usdc: number;
  elapsed_ms: number;
}

export interface BudgetTracker {
  /** Accumulate token counts from a stream chunk */
  addUsage(inputTokens: number, outputTokens: number): void;
  /** Returns budget-exceeded info, or null if still within limits */
  check(): BudgetCheckResult | null;
  /** Returns true when the request has exceeded its time limit */
  checkTimeout(): boolean;
  /** Current running totals */
  summary(): BudgetSummary;
  /** Remaining budget estimate in USDC */
  remaining(): number;
}

// ── Defaults ─────────────────────────────────────────────────────

export const DEFAULT_MAX_COST_USDC = 1.0;
export const DEFAULT_MAX_DURATION_MS = 120_000; // 2 minutes

// ── Factory ──────────────────────────────────────────────────────

export function createBudgetTracker(
  model: string,
  config: BudgetConfig,
): BudgetTracker {
  const maxCost = config.max_cost_usdc;
  const maxDuration = config.max_duration_ms ?? DEFAULT_MAX_DURATION_MS;
  const startedAt = Date.now();

  let totalInput = 0;
  let totalOutput = 0;

  function estimateCost(): number {
    if (totalInput === 0 && totalOutput === 0) return 0;
    const usage: NormalizedUsage = { input: totalInput, output: totalOutput };
    try {
      const breakdown: CostBreakdown = calculateCostByModel(usage, model);
      return breakdown.totalCost;
    } catch {
      // Unknown model – fall back to an expensive default ($30/$60 per 1M)
      // so the guard stays conservative.
      const fallbackInput = (totalInput * 30) / 1_000_000;
      const fallbackOutput = (totalOutput * 60) / 1_000_000;
      return fallbackInput + fallbackOutput;
    }
  }

  const tracker: BudgetTracker = {
    addUsage(inputTokens: number, outputTokens: number): void {
      totalInput += inputTokens;
      totalOutput += outputTokens;
    },

    check(): BudgetCheckResult | null {
      const cost = estimateCost();
      if (cost > maxCost) {
        const result: BudgetCheckResult = {
          exceeded: true,
          used_usdc: cost,
          limit_usdc: maxCost,
          reason: `Cost $${cost.toFixed(6)} exceeds budget $${maxCost.toFixed(2)}`,
        };
        log.warn('budget_exceeded', {
          model,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cost,
          limit: maxCost,
        });
        return result;
      }
      return null;
    },

    checkTimeout(): boolean {
      const elapsed = Date.now() - startedAt;
      if (elapsed > maxDuration) {
        log.warn('budget_timeout', {
          model,
          elapsed_ms: elapsed,
          limit_ms: maxDuration,
        });
        return true;
      }
      return false;
    },

    summary(): BudgetSummary {
      return {
        input_tokens: totalInput,
        output_tokens: totalOutput,
        estimated_cost_usdc: estimateCost(),
        elapsed_ms: Date.now() - startedAt,
      };
    },

    remaining(): number {
      return Math.max(0, maxCost - estimateCost());
    },
  };

  return tracker;
}
