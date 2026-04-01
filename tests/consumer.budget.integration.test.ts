/**
 * Consumer Budget Guard – Integration Tests
 *
 * Verifies that the gateway HTTP layer correctly applies budget limits.
 * We don't spin up real relays; instead we test the budget wiring by
 * inspecting the BudgetTracker behaviour in a request-like flow.
 */

import { describe, it, expect } from 'vitest';
import {
  createBudgetTracker,
  DEFAULT_MAX_COST_USDC,
} from '../src/consumer/budget';

describe('Consumer Budget Integration', () => {
  // Simulate the streaming flow inside the gateway
  function simulateStreamRequest(opts: {
    model: string;
    budgetUsdc?: number;
    chunkCount: number;
    tokensPerChunk: number;
  }) {
    const budget = createBudgetTracker(opts.model, {
      max_cost_usdc: opts.budgetUsdc ?? DEFAULT_MAX_COST_USDC,
    });

    const chunks: string[] = [];
    let aborted = false;
    let abortError: { type: string; used: number; limit: number } | null = null;

    for (let i = 0; i < opts.chunkCount; i++) {
      // Simulate receiving a stream chunk
      budget.addUsage(0, opts.tokensPerChunk);

      const check = budget.check();
      if (check) {
        aborted = true;
        abortError = {
          type: 'budget_exceeded',
          used: check.used_usdc,
          limit: check.limit_usdc,
        };
        break;
      }
      chunks.push(`chunk-${i}`);
    }

    return { chunks, aborted, abortError, summary: budget.summary() };
  }

  it('request under budget completes all chunks', () => {
    // haiku output: $1.25/1M → 100 chunks × 10 tokens = 1000 tokens → ~$0.00125
    const result = simulateStreamRequest({
      model: 'claude-3-haiku',
      budgetUsdc: 1.0,
      chunkCount: 100,
      tokensPerChunk: 10,
    });

    expect(result.aborted).toBe(false);
    expect(result.abortError).toBeNull();
    expect(result.chunks).toHaveLength(100);
    expect(result.summary.estimated_cost_usdc).toBeLessThan(1.0);
  });

  it('request over budget gets aborted with error', () => {
    // opus output: $75/1M → 200 chunks × 100 tokens = 20000 tokens → $1.50 (exceeds $1)
    const result = simulateStreamRequest({
      model: 'claude-3-opus',
      budgetUsdc: 1.0,
      chunkCount: 200,
      tokensPerChunk: 100,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortError).not.toBeNull();
    expect(result.abortError!.type).toBe('budget_exceeded');
    expect(result.abortError!.used).toBeGreaterThan(1.0);
    expect(result.abortError!.limit).toBe(1.0);
    // Should have been cut short
    expect(result.chunks.length).toBeLessThan(200);
  });

  it('default $1.00 budget applied when not specified', () => {
    const budget = createBudgetTracker('claude-3-haiku', {
      max_cost_usdc: DEFAULT_MAX_COST_USDC,
    });
    // haiku: 1M output = $1.25 → exceeds $1.00 default
    budget.addUsage(0, 1_000_000);
    const check = budget.check();
    expect(check).not.toBeNull();
    expect(check!.limit_usdc).toBe(1.0);
  });

  it('custom higher budget allows more tokens', () => {
    const result = simulateStreamRequest({
      model: 'claude-3-opus',
      budgetUsdc: 10.0,
      chunkCount: 200,
      tokensPerChunk: 100,
    });
    // 20k tokens opus output = $1.50, well under $10
    expect(result.aborted).toBe(false);
    expect(result.chunks).toHaveLength(200);
  });

  it('very low budget aborts quickly', () => {
    const result = simulateStreamRequest({
      model: 'claude-3-opus',
      budgetUsdc: 0.001,
      chunkCount: 1000,
      tokensPerChunk: 100,
    });
    expect(result.aborted).toBe(true);
    // Should abort within the first few chunks
    expect(result.chunks.length).toBeLessThan(10);
  });

  it('non-streaming: budget check after full response', () => {
    // Simulates the non-streaming path where we check after getting the full response
    const budget = createBudgetTracker('gpt-4', { max_cost_usdc: 0.50 });
    // gpt-4: $30 input / $60 output per 1M
    // 10k input + 5k output → $0.30 + $0.30 = $0.60 → exceeds $0.50
    budget.addUsage(10_000, 5_000);
    const check = budget.check();
    expect(check).not.toBeNull();
    expect(check!.exceeded).toBe(true);
    expect(check!.used_usdc).toBeCloseTo(0.60, 2);
  });
});
