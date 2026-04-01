/**
 * Metering Module Tests
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeUsage,
  normalizeUsageBatch,
  aggregateUsage,
  calculateCost,
  calculateCostByModel,
  formatCost,
  formatCostBreakdown,
  generateWitness,
  DEFAULT_PRICE_TABLE,
} from '../src/metering';

describe('Metering Module', () => {
  describe('normalizeUsage', () => {
    it('normalizes Anthropic format', () => {
      const anthropicUsage = {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      };

      const normalized = normalizeUsage(anthropicUsage);

      expect(normalized.input).toBe(1000);
      expect(normalized.output).toBe(500);
      expect(normalized.cacheRead).toBe(200);
      expect(normalized.cacheWrite).toBe(100);
    });

    it('normalizes OpenAI format', () => {
      const openaiUsage = {
        prompt_tokens: 800,
        completion_tokens: 400,
        prompt_tokens_details: {
          cached_tokens: 150,
        },
      };

      const normalized = normalizeUsage(openaiUsage);

      expect(normalized.input).toBe(800);
      expect(normalized.output).toBe(400);
      expect(normalized.cacheRead).toBe(150);
    });

    it('normalizes Google format', () => {
      const googleUsage = {
        promptTokenCount: 1200,
        candidatesTokenCount: 600,
        cachedContentTokenCount: 300,
      };

      const normalized = normalizeUsage(googleUsage);

      expect(normalized.input).toBe(1200);
      expect(normalized.output).toBe(600);
      expect(normalized.cacheRead).toBe(300);
    });

    it('handles usage without cache fields', () => {
      const usage = {
        input_tokens: 1000,
        output_tokens: 500,
      };

      const normalized = normalizeUsage(usage);

      expect(normalized.input).toBe(1000);
      expect(normalized.output).toBe(500);
      expect(normalized.cacheRead).toBeUndefined();
      expect(normalized.cacheWrite).toBeUndefined();
    });
  });

  describe('normalizeUsageBatch', () => {
    it('normalizes multiple usage records', () => {
      const usages = [
        { input_tokens: 1000, output_tokens: 500 },
        { prompt_tokens: 800, completion_tokens: 400 },
      ];

      const normalized = normalizeUsageBatch(usages);

      expect(normalized).toHaveLength(2);
      expect(normalized[0].input).toBe(1000);
      expect(normalized[1].input).toBe(800);
    });
  });

  describe('aggregateUsage', () => {
    it('aggregates multiple usage records', () => {
      const usages = [
        { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50 },
        { input: 800, output: 400, cacheRead: 200, cacheWrite: 100 },
      ];

      const aggregated = aggregateUsage(usages);

      expect(aggregated.input).toBe(1800);
      expect(aggregated.output).toBe(900);
      expect(aggregated.cacheRead).toBe(300);
      expect(aggregated.cacheWrite).toBe(150);
    });

    it('handles empty array', () => {
      const aggregated = aggregateUsage([]);

      expect(aggregated.input).toBe(0);
      expect(aggregated.output).toBe(0);
    });
  });

  describe('calculateCost', () => {
    const priceConfig = {
      model: 'test-model',
      inputPerM: 10,
      outputPerM: 30,
    };

    it('calculates cost correctly', () => {
      const usage = { input: 1_000_000, output: 500_000 };

      const cost = calculateCost(usage, priceConfig);

      expect(cost.inputCost).toBe(10);
      expect(cost.outputCost).toBe(15);
      expect(cost.totalCost).toBe(25);
    });

    it('includes cache costs when applicable', () => {
      const priceConfigWithCache = {
        model: 'test-model',
        inputPerM: 10,
        outputPerM: 30,
        cacheReadPerM: 5,
        cacheWritePerM: 15,
      };

      const usage = {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 200_000,
        cacheWrite: 100_000,
      };

      const cost = calculateCost(usage, priceConfigWithCache);

      expect(cost.inputCost).toBe(10);
      expect(cost.outputCost).toBe(15);
      expect(cost.cacheReadCost).toBe(1);
      expect(cost.cacheWriteCost).toBe(1.5);
      expect(cost.totalCost).toBe(27.5);
    });

    it('handles zero usage', () => {
      const usage = { input: 0, output: 0 };

      const cost = calculateCost(usage, priceConfig);

      expect(cost.totalCost).toBe(0);
    });
  });

  describe('calculateCostByModel', () => {
    it('calculates cost using model from price table', () => {
      const usage = { input: 1_000_000, output: 500_000 };

      const cost = calculateCostByModel(usage, 'claude-3-sonnet');

      // claude-3-sonnet: inputPerM=3, outputPerM=15
      expect(cost.inputCost).toBe(3);
      expect(cost.outputCost).toBe(7.5);
      expect(cost.totalCost).toBe(10.5);
    });

    it('throws error for unknown model', () => {
      const usage = { input: 1000, output: 500 };

      expect(() => calculateCostByModel(usage, 'unknown-model')).toThrow(
        'Unknown model: unknown-model'
      );
    });
  });

  describe('formatCost', () => {
    it('formats cost as USD string', () => {
      expect(formatCost(0.000001)).toBe('$0.000001');
      expect(formatCost(0.00001)).toBe('$0.000010');
      expect(formatCost(0.0001)).toBe('$0.000100');
      expect(formatCost(0.001)).toBe('$0.001000');
      expect(formatCost(0.01)).toBe('$0.010000');
      expect(formatCost(0.1)).toBe('$0.100000');
      expect(formatCost(1)).toBe('$1.000000');
    });
  });

  describe('formatCostBreakdown', () => {
    it('formats cost breakdown as human-readable string', () => {
      const breakdown = {
        inputCost: 0.003,
        outputCost: 0.0075,
        totalCost: 0.0105,
      };

      const formatted = formatCostBreakdown(breakdown);

      expect(formatted).toContain('Input: $0.003000');
      expect(formatted).toContain('Output: $0.007500');
      expect(formatted).toContain('Total: $0.010500');
    });

    it('includes cache costs when present', () => {
      const breakdown = {
        inputCost: 0.003,
        outputCost: 0.0075,
        cacheReadCost: 0.001,
        cacheWriteCost: 0.0015,
        totalCost: 0.013,
      };

      const formatted = formatCostBreakdown(breakdown);

      expect(formatted).toContain('Cache Read: $0.001000');
      expect(formatted).toContain('Cache Write: $0.001500');
    });
  });

  describe('generateWitness', () => {
    it('generates witness with signature', async () => {
      const usage = { input: 1000, output: 500 };
      const cost = {
        inputCost: 0.003,
        outputCost: 0.0075,
        totalCost: 0.0105,
      };
      const relayPrivateKey = 'test-private-key';

      const witness = await generateWitness(
        'test-request-123',
        usage,
        cost,
        relayPrivateKey
      );

      expect(witness.request_id).toBe('test-request-123');
      expect(witness.usage).toEqual(usage);
      expect(witness.cost).toEqual(cost);
      expect(witness.timestamp).toBeDefined();
      expect(witness.relay_signature).toBeDefined();
      expect(witness.relay_signature.length).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_PRICE_TABLE', () => {
    it('contains expected models', () => {
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('claude-3-opus');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('claude-3-sonnet');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('claude-3-haiku');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('gpt-4-turbo');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('gpt-4');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('gpt-3.5-turbo');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('gemini-pro');
      expect(DEFAULT_PRICE_TABLE).toHaveProperty('gemini-ultra');
    });

    it('has valid price configs', () => {
      Object.values(DEFAULT_PRICE_TABLE).forEach(config => {
        expect(config).toHaveProperty('model');
        expect(config).toHaveProperty('inputPerM');
        expect(config).toHaveProperty('outputPerM');
        expect(config.inputPerM).toBeGreaterThanOrEqual(0);
        expect(config.outputPerM).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
