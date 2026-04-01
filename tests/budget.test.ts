/**
 * Budget Guard – Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createBudgetTracker,
  DEFAULT_MAX_COST_USDC,
  DEFAULT_MAX_DURATION_MS,
} from '../src/consumer/budget';
import { calculateCostByModel, DEFAULT_PRICE_TABLE } from '../src/metering/index';

describe('Budget Guard', () => {
  // ── Defaults ────────────────────────────────────────────────
  describe('defaults', () => {
    it('default max cost is $1.00', () => {
      expect(DEFAULT_MAX_COST_USDC).toBe(1.0);
    });

    it('default max duration is 120 000 ms', () => {
      expect(DEFAULT_MAX_DURATION_MS).toBe(120_000);
    });
  });

  // ── Token accumulation ──────────────────────────────────────
  describe('addUsage / summary', () => {
    it('starts at zero', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      const s = t.summary();
      expect(s.input_tokens).toBe(0);
      expect(s.output_tokens).toBe(0);
      expect(s.estimated_cost_usdc).toBe(0);
    });

    it('accumulates input and output tokens', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      t.addUsage(100, 50);
      t.addUsage(200, 150);
      const s = t.summary();
      expect(s.input_tokens).toBe(300);
      expect(s.output_tokens).toBe(200);
    });

    it('cost calculation matches metering module', () => {
      const model = 'claude-3-haiku';
      const t = createBudgetTracker(model, { max_cost_usdc: 10 });
      t.addUsage(10_000, 5_000);
      const s = t.summary();

      // Cross-check with metering directly
      const expected = calculateCostByModel(
        { input: 10_000, output: 5_000 },
        model,
      );
      expect(s.estimated_cost_usdc).toBeCloseTo(expected.totalCost, 10);
    });
  });

  // ── Budget exceeded ─────────────────────────────────────────
  describe('check (cost limit)', () => {
    it('returns null when under budget', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      t.addUsage(100, 50);
      expect(t.check()).toBeNull();
    });

    it('returns exceeded info when over budget', () => {
      // haiku: $0.25 input / $1.25 output per 1M
      // 1M output tokens → $1.25  (exceeds $1.00 budget)
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      t.addUsage(0, 1_000_000);

      const result = t.check();
      expect(result).not.toBeNull();
      expect(result!.exceeded).toBe(true);
      expect(result!.used_usdc).toBeGreaterThan(1.0);
      expect(result!.limit_usdc).toBe(1.0);
      expect(result!.reason).toContain('exceeds budget');
    });

    it('triggers for expensive model with smaller token count', () => {
      // opus: $15 input / $75 output per 1M
      // 20k output → $1.50 → exceeds $1.00
      const t = createBudgetTracker('claude-3-opus', { max_cost_usdc: 1.0 });
      t.addUsage(0, 20_000);

      const result = t.check();
      expect(result).not.toBeNull();
      expect(result!.exceeded).toBe(true);
    });

    it('respects custom budget', () => {
      const t = createBudgetTracker('claude-3-opus', { max_cost_usdc: 5.0 });
      t.addUsage(0, 20_000);
      // 20k output at opus = $1.50, under $5 budget
      expect(t.check()).toBeNull();
    });

    it('uses conservative fallback for unknown model', () => {
      const t = createBudgetTracker('unknown-model-xyz', { max_cost_usdc: 0.001 });
      t.addUsage(0, 1000);
      // Fallback: 1000 * 60 / 1M = $0.06 → exceeds $0.001
      const result = t.check();
      expect(result).not.toBeNull();
      expect(result!.exceeded).toBe(true);
    });
  });

  // ── Timeout ─────────────────────────────────────────────────
  describe('checkTimeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns false before timeout', () => {
      const t = createBudgetTracker('claude-3-haiku', {
        max_cost_usdc: 1.0,
        max_duration_ms: 5000,
      });
      vi.advanceTimersByTime(3000);
      expect(t.checkTimeout()).toBe(false);
    });

    it('returns true after timeout', () => {
      const t = createBudgetTracker('claude-3-haiku', {
        max_cost_usdc: 1.0,
        max_duration_ms: 5000,
      });
      vi.advanceTimersByTime(6000);
      expect(t.checkTimeout()).toBe(true);
    });

    it('uses default 120s when max_duration_ms not specified', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      vi.advanceTimersByTime(119_000);
      expect(t.checkTimeout()).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(t.checkTimeout()).toBe(true);
    });
  });

  // ── remaining() ─────────────────────────────────────────────
  describe('remaining', () => {
    it('starts at full budget', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      expect(t.remaining()).toBe(1.0);
    });

    it('decreases as tokens accumulate', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      t.addUsage(100_000, 50_000);
      expect(t.remaining()).toBeLessThan(1.0);
      expect(t.remaining()).toBeGreaterThan(0);
    });

    it('floors at zero when exceeded', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 0.001 });
      t.addUsage(100_000, 100_000);
      expect(t.remaining()).toBe(0);
    });
  });

  // ── elapsed_ms in summary ───────────────────────────────────
  describe('summary elapsed_ms', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('tracks elapsed time', () => {
      const t = createBudgetTracker('claude-3-haiku', { max_cost_usdc: 1.0 });
      vi.advanceTimersByTime(500);
      const s = t.summary();
      expect(s.elapsed_ms).toBeGreaterThanOrEqual(500);
    });
  });
});
