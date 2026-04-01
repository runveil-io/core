// src/consumer/anthropic-stream.ts

import { AbortController } from 'abort-controller';
import { EventEmitter } from 'events';

class AnthropicStream extends EventEmitter {
  private timeoutMs: number;
  private abortController: AbortController;
  private timeoutId: NodeJS.Timeout | null = null;

  constructor(timeoutMs = 120000) {
    super();
    this.timeoutMs = timeoutMs;
    this.abortController = new AbortController();
  }

  startConsumer() {
    this.startTimeout();
    // Existing stream start logic
  }

  startTimeout() {
    this.timeoutId = setTimeout(() => {
      this.cancel('timeout');
    }, this.timeoutMs);
  }

  cancel(reason: string) {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.abortController.abort();
    this.emit('error', { type: 'error', code: 'timeout', reason });
  }

  handleProviderRequest() {
    // Existing request handling logic
    const headers = {
      // Existing headers
    }; // Added missing closing bracket

    fetch('provider-url', {
      method: 'POST',
      headers,
      body: JSON.stringify({ request_id: '123' }),
      signal: this.abortController.signal,
    })
      .then(response => response.json())
      .then(data => this.handleStreamChunk(data))
      .catch(error => {
        if (error.name === 'AbortError') {
          this.emit('error', { type: 'error', code: 'abort', reason: 'Request aborted' });
        } else {
          this.emit('error', { type: 'error', code: 'fetch', reason: error.message });
        }
      });
  }

  handleStreamChunk(chunk: string) {
    try {
      const data = JSON.parse(chunk);
      // Existing chunk handling logic
    } catch (error) {
      this.emit('error', { type: 'error', code: 'parse', reason: 'Invalid JSON' });
    }
  }
}

export default AnthropicStream;