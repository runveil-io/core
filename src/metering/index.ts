/**
 * Metering Module
 * 
 * Usage normalization, pricing, and witness generation for settlement
 */

// Types
export type {
  NormalizedUsage,
  PriceConfig,
  CostBreakdown,
  Witness,
  AnthropicUsage,
  OpenAIUsage,
  GoogleUsage,
  AnyUsage,
} from './types';

// Normalization
export {
  normalizeUsage,
  normalizeUsageBatch,
  aggregateUsage,
} from './normalize';

// Pricing
export {
  calculateCost,
  calculateCostByModel,
  calculateCostBatch,
  formatCost,
  formatCostBreakdown,
  DEFAULT_PRICE_TABLE,
} from './pricing';

// Witness
export {
  generateWitness,
  verifyWitness,
  generateWitnessBatch,
  serializeWitness,
  deserializeWitness,
} from './witness';
