import { describe, it, expect } from 'vitest';
import { ProviderSelector } from '../src/consumer/selector.js';
import type { ProviderInfo } from '../src/types.js';

describe('ProviderSelector', () => {
  const mockProviders: ProviderInfo[] = [
    { provider_id: 'p1', encryption_pubkey: 'pub1', models: ['model-a'], capacity: 10 },
    { provider_id: 'p2', encryption_pubkey: 'pub2', models: ['model-a', 'model-b'], capacity: 20 },
    { provider_id: 'p3', encryption_pubkey: 'pub3', models: ['model-b'], capacity: 15 },
    { provider_id: 'p4', encryption_pubkey: 'pub4', models: ['model-a'], capacity: 0 },
  ];

  it('selects providers for a given model, sorted by capacity', () => {
    const selector = new ProviderSelector();
    const candidates = selector.getProvidersForModel('model-a', mockProviders);
    
    expect(candidates).toHaveLength(2);
    expect(candidates[0].provider_id).toBe('p2'); // capacity 20
    expect(candidates[1].provider_id).toBe('p1'); // capacity 10
  });

  it('ignores providers without capacity', () => {
    const selector = new ProviderSelector();
    const candidates = selector.getProvidersForModel('model-a', mockProviders);
    
    expect(candidates.find(p => p.provider_id === 'p4')).toBeUndefined();
  });

  it('demotes providers with reported errors', () => {
    const selector = new ProviderSelector();
    selector.reportError('p2');
    
    const candidates = selector.getProvidersForModel('model-a', mockProviders);
    
    expect(candidates).toHaveLength(2);
    // p1 has no errors, so it should be first despite lower capacity
    expect(candidates[0].provider_id).toBe('p1');
    expect(candidates[1].provider_id).toBe('p2');
  });

  it('restores provider order on success', () => {
    const selector = new ProviderSelector();
    selector.reportError('p2');
    selector.reportSuccess('p2');
    
    const candidates = selector.getProvidersForModel('model-a', mockProviders);
    
    // p2 recovers and is back to first
    expect(candidates[0].provider_id).toBe('p2');
    expect(candidates[1].provider_id).toBe('p1');
  });
});
