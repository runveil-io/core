export class MetricsStore {
  totalRequests: number = 0;
  totalErrors: number = 0;
  modelRequests: Record<string, number> = {};
  recentLatencies: number[] = [];

  recordRequest(model: string, latencyMs: number, isError: boolean) {
    this.totalRequests++;
    if (isError) this.totalErrors++;
    
    this.modelRequests[model] = (this.modelRequests[model] || 0) + 1;
    
    this.recentLatencies.push(latencyMs);
    if (this.recentLatencies.length > 1000) {
      this.recentLatencies.shift();
    }
  }

  getMetrics() {
    const latencies = [...this.recentLatencies].sort((a, b) => a - b);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;
    const p99 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : 0;
    
    return {
      total_requests: this.totalRequests,
      error_rate: this.totalRequests > 0 ? this.totalErrors / this.totalRequests : 0,
      models: this.modelRequests,
      latency: {
        p50,
        p95,
        p99
      }
    };
  }
}
