import { describe, it, expect } from 'vitest';
import { MetricsStore } from '../src/provider/metrics.js';

describe('MetricsStore', () => {
  it('should initialize with zeros', () => {
    const metrics = new MetricsStore();
    const stats = metrics.getMetrics();
    expect(stats.total_requests).toBe(0);
    expect(stats.error_rate).toBe(0);
    expect(Object.keys(stats.models).length).toBe(0);
    expect(stats.latency.p50).toBe(0);
    expect(stats.latency.p95).toBe(0);
    expect(stats.latency.p99).toBe(0);
  });

  it('should record requests and update counters', () => {
    const metrics = new MetricsStore();
    metrics.recordRequest('model-a', 100, false);
    metrics.recordRequest('model-a', 150, true);
    metrics.recordRequest('model-b', 200, false);

    const stats = metrics.getMetrics();
    expect(stats.total_requests).toBe(3);
    expect(stats.error_rate).toBe(1 / 3);
    expect(stats.models['model-a']).toBe(2);
    expect(stats.models['model-b']).toBe(1);
  });

  it('should calculate percentiles correctly', () => {
    const metrics = new MetricsStore();
    for (let i = 1; i <= 100; i++) {
      metrics.recordRequest('model-a', i, false);
    }
    
    // latencies: [1, 2, ..., 100]
    const stats = metrics.getMetrics();
    expect(stats.latency.p50).toBe(51); // index 50
    expect(stats.latency.p95).toBe(96); // index 95
    expect(stats.latency.p99).toBe(100); // index 99
  });

  it('should keep only the last 1000 requests for latency', () => {
    const metrics = new MetricsStore();
    for (let i = 1; i <= 1500; i++) {
      metrics.recordRequest('model-a', i, false);
    }
    
    // Total requests should be 1500, but latency array should have only 1000 items
    expect(metrics.totalRequests).toBe(1500);
    expect(metrics.recentLatencies.length).toBe(1000);
    
    // The latencies should be from 501 to 1500
    // so p99 = 1500, p50 roughly 1001
    const stats = metrics.getMetrics();
    expect(stats.latency.p50).toBe(1001);
    expect(stats.latency.p99).toBe(1491); // Math.floor(1000 * 0.99) = 990 -> index 990 of [501, 502..., 1500] = 501 + 990 = 1491
  });
});
