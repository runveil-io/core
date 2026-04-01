// src/types.ts
export enum MessageType {
  PROBE = 'probe',
  PROBE_ACK = 'probe_ack',
  // other message types...
}

export interface ProbeMessage {
  type: MessageType.PROBE;
  request_id: string;
  timestamp: number;
}

export interface ProbeAckMessage {
  type: MessageType.PROBE_ACK;
  status: 'alive' | 'busy' | 'rate_limited';
  progress?: number;
}

// src/relay/index.ts
import { MessageType, ProbeMessage, ProbeAckMessage } from '../types';
import { Provider } from './provider';

class Relay {
  private providers: { [key: string]: Provider } = {};
  private lastActivity: { [key: string]: number } = {};

  sendProbe(providerId: string) {
    const provider = this.providers[providerId];
    if (provider) {
      const probeMessage: ProbeMessage = {
        type: MessageType.PROBE,
        request_id: provider.requestId,
        timestamp: Date.now(),
      };
      provider.sendMessage(probeMessage);
    }
  }

  handleProbeAck(providerId: string, probeAck: ProbeAckMessage) {
    if (probeAck.status === 'alive') {
      this.lastActivity[providerId] = Date.now();
    }
  }

  startMonitoring() {
    setInterval(() => {
      for (const providerId in this.providers) {
        if (!this.lastActivity[providerId] || Date.now() - this.lastActivity[providerId] > 30000) {
          this.sendProbe(providerId);
        }
      }
    }, 10000);
  }
}

// src/provider/index.ts
import { MessageType, ProbeMessage, ProbeAckMessage } from '../types';

class Provider {
  private requestId: string;

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  sendMessage(message: ProbeMessage | ProbeAckMessage) {
    // implementation to send message to relay
  }

  handleProbe(probe: ProbeMessage) {
    const probeAck: ProbeAckMessage = {
      type: MessageType.PROBE_ACK,
      status: 'alive', // or 'busy', 'rate_limited' based on actual status
    };
    this.sendMessage(probeAck);
  }
}

// tests/probe.test.ts
import { Relay, Provider } from '../src';

describe('Probe Handling', () => {
  let relay: Relay;
  let provider: Provider;

  beforeEach(() => {
    relay = new Relay();
    provider = new Provider('request123');
    relay.providers['provider1'] = provider;
  });

  it('should send a probe after 30s of silence', () => {
    // Mock the current time to simulate 30s of silence
    jest.useFakeTimers();
    jest.advanceTimersByTime(30000);
    expect(relay.lastActivity['provider1']).toBeUndefined();
    jest.runAllTimers();
    expect(relay.lastActivity['provider1']).toBeDefined();
  });

  it('should handle a probe ack', () => {
    const probeAck: ProbeAckMessage = {
      type: MessageType.PROBE_ACK,
      status: 'alive',
    };
    relay.handleProbeAck('provider1', probeAck);
    expect(relay.lastActivity['provider1']).toBeDefined();
  });

  it('should declare a provider dead after 2 consecutive probe failures', () => {
    // Mock the current time to simulate 30s of silence
    jest.useFakeTimers();
    jest.advanceTimersByTime(30000);
    jest.runAllTimers();
    // Simulate a failure
    delete relay.lastActivity['provider1'];
    jest.advanceTimersByTime(30000);
    jest.runAllTimers();
    // Simulate another failure
    delete relay.lastActivity['provider1'];
    jest.advanceTimersByTime(30000);
    jest.runAllTimers();
    expect(relay.providers['provider1']).toBeUndefined();
  });
});