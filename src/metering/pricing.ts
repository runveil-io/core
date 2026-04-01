/**
 * Metering Module - Pricing
 * 
 * Calculate cost based on normalized usage and price configuration
 */

import type { NormalizedUsage, PriceConfig, CostBreakdown } from './types';

/**
 * Default price table (USD per 1M tokens)
 */
export const DEFAULT_PRICE_TABLE: Record<string, PriceConfig> = {
  // Anthropic models
  'claude-3-opus': { model: 'claude-3-opus', inputPerM: 15, outputPerM: 75 },
  'claude-3-sonnet': { model: 'claude-3-sonnet', inputPerM: 3, outputPerM: 15 },
  'claude-3-haiku': { model: 'claude-3-haiku', inputPerM: 0.25, outputPerM: 1.25 },
  
  // OpenAI models
  'gpt-4-turbo': { model: 'gpt-4-turbo', inputPerM: 10, outputPerM: 30 },
  'gpt-4': { model: 'gpt-4', inputPerM: 30, outputPerM: 60 },
  'gpt-3.5-turbo': { model: 'gpt-3.5-turbo', inputPerM: 0.5, outputPerM: 1.5 },
  
  // Google models
  'gemini-pro': { model: 'gemini-pro', inputPerM: 0.5, outputPerM: 1.5 },
  'gemini-ultra': { model: 'gemini-ultra', inputPerM: 7, outputPerM: 21 },
};

/**
 * Calculate cost for normalized usage
 * Formula: (input × inputPrice + output × outputPrice) / 1M
 */
export function calculateCost(
  usage: NormalizedUsage,
  priceConfig: PriceConfig
): CostBreakdown {
  const inputCost = (usage.input * priceConfig.inputPerM) / 1_000_000;
  const outputCost = (usage.output * priceConfig.outputPerM) / 1_000_000;
  
  const result: CostBreakdown = {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };

  // Add cache costs if applicable
  if (usage.cacheRead !== undefined && priceConfig.cacheReadPerM !== undefined) {
    const cacheReadCost = (usage.cacheRead * priceConfig.cacheReadPerM) / 1_000_000;
    result.cacheReadCost = cacheReadCost;
    result.totalCost += cacheReadCost;
  }

  if (usage.cacheWrite !== undefined && priceConfig.cacheWritePerM !== undefined) {
    const cacheWriteCost = (usage.cacheWrite * priceConfig.cacheWritePerM) / 1_000_000;
    result.cacheWriteCost = cacheWriteCost;
    result.totalCost += cacheWriteCost;
  }

  return result;
}

/**
 * Calculate cost with model lookup from price table
 */
export function calculateCostByModel(
  usage: NormalizedUsage,
  model: string,
  priceTable: Record<string, PriceConfig> = DEFAULT_PRICE_TABLE
): CostBreakdown {
  const priceConfig = priceTable[model];
  
  if (!priceConfig) {
    throw new Error(`Unknown model: ${model}. Available models: ${Object.keys(priceTable).join(', ')}`);
  }

  return calculateCost(usage, priceConfig);
}

/**
 * Calculate batch costs
 */
export function calculateCostBatch(
  usageRecords: NormalizedUsage[],
  priceConfig: PriceConfig
): CostBreakdown[] {
  return usageRecords.map(usage => calculateCost(usage, priceConfig));
}

/**
 * Format cost as USD string
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(6)}`;
}

/**
 * Format cost breakdown as human-readable string
 */
export function formatCostBreakdown(breakdown: CostBreakdown): string {
  const parts = [
    `Input: ${formatCost(breakdown.inputCost)}`,
    `Output: ${formatCost(breakdown.outputCost)}`,
  ];
  
  if (breakdown.cacheReadCost !== undefined) {
    parts.push(`Cache Read: ${formatCost(breakdown.cacheReadCost)}`);
  }
  
  if (breakdown.cacheWriteCost !== undefined) {
    parts.push(`Cache Write: ${formatCost(breakdown.cacheWriteCost)}`);
  }
  
  parts.push(`Total: ${formatCost(breakdown.totalCost)}`);
  
  return parts.join(' | ');
}
