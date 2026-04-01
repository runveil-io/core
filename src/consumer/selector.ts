import type { ProviderInfo } from '../types.js';

export class ProviderSelector {
  private errorCounts: Map<string, number> = new Map();

  public getProvidersForModel(model: string, providers: ProviderInfo[]): ProviderInfo[] {
    const available = providers.filter(
      (p) => p.models.includes(model) && p.capacity > 0
    );

    return available.sort((a, b) => {
      const errA = this.errorCounts.get(a.provider_id) || 0;
      const errB = this.errorCounts.get(b.provider_id) || 0;
      
      if (errA !== errB) {
        return errA - errB;
      }
      
      return b.capacity - a.capacity;
    });
  }

  public reportError(providerId: string): void {
    const count = this.errorCounts.get(providerId) || 0;
    this.errorCounts.set(providerId, count + 1);
  }

  public reportSuccess(providerId: string): void {
    const count = this.errorCounts.get(providerId) || 0;
    if (count > 0) {
      this.errorCounts.set(providerId, count - 1);
    }
  }
}
