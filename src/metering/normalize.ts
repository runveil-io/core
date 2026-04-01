/**
 * Metering Module - Usage Normalization
 * 
 * Normalizes usage from different provider formats into unified format
 */

import type { NormalizedUsage, AnyUsage, AnthropicUsage, OpenAIUsage, GoogleUsage } from './types';

/**
 * Check if usage is Anthropic format
 */
function isAnthropic(usage: AnyUsage): usage is AnthropicUsage {
  return 'input_tokens' in usage && 'output_tokens' in usage;
}

/**
 * Check if usage is OpenAI format
 */
function isOpenAI(usage: AnyUsage): usage is OpenAIUsage {
  return 'prompt_tokens' in usage && 'completion_tokens' in usage;
}

/**
 * Check if usage is Google format
 */
function isGoogle(usage: AnyUsage): usage is GoogleUsage {
  return 'promptTokenCount' in usage && 'candidatesTokenCount' in usage;
}

/**
 * Normalize usage from any provider format into unified format
 * 
 * Handles:
 * - Anthropic: input_tokens, output_tokens, cache_*_tokens
 * - OpenAI: prompt_tokens, completion_tokens, prompt_tokens_details
 * - Google: promptTokenCount, candidatesTokenCount, cachedContentTokenCount
 */
export function normalizeUsage(usage: AnyUsage): NormalizedUsage {
  if (isAnthropic(usage)) {
    return {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    };
  }

  if (isOpenAI(usage)) {
    return {
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
      cacheRead: usage.prompt_tokens_details?.cached_tokens,
    };
  }

  if (isGoogle(usage)) {
    return {
      input: usage.promptTokenCount,
      output: usage.candidatesTokenCount,
      cacheRead: usage.cachedContentTokenCount,
    };
  }

  // Fallback: try generic field mapping
  const result: NormalizedUsage = {
    input: (usage as Record<string, unknown>).input_tokens as number ??
           (usage as Record<string, unknown>).prompt_tokens as number ??
           (usage as Record<string, unknown>).promptTokenCount as number ?? 0,
    output: (usage as Record<string, unknown>).output_tokens as number ??
            (usage as Record<string, unknown>).completion_tokens as number ??
            (usage as Record<string, unknown>).candidatesTokenCount as number ?? 0,
  };

  return result;
}

/**
 * Normalize multiple usage records
 */
export function normalizeUsageBatch(usageRecords: AnyUsage[]): NormalizedUsage[] {
  return usageRecords.map(normalizeUsage);
}

/**
 * Aggregate multiple normalized usage records
 */
export function aggregateUsage(usageRecords: NormalizedUsage[]): NormalizedUsage {
  return usageRecords.reduce(
    (acc, usage) => ({
      input: acc.input + usage.input,
      output: acc.output + usage.output,
      cacheRead: (acc.cacheRead ?? 0) + (usage.cacheRead ?? 0),
      cacheWrite: (acc.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );
}
