// src/provider/index.ts

import { ProviderConfig } from '../config/bootstrap';
import { Logger } from '../logger';
import axios, { AxiosError } from 'axios';

interface KeyPool {
  keys: string[];
  currentIndex: number;
  errorCounts: { [key: string]: number };
  cooldowns: { [key: string]: number };
}

export class Provider {
  private config: ProviderConfig;
  private logger: Logger;
  private keyPool: KeyPool;

  constructor(config: ProviderConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.keyPool = {
      keys: config.apiKeys,
      currentIndex: 0,
      errorCounts: {},
      cooldowns: {},
    };
  }

  private async makeRequest(url: string, apiKey: string): Promise<any> {
    try {
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response?.status === 429 || axiosError.response?.status === 529) {
          this.handleRateLimit(apiKey);
        }
      }
      throw error;
    }
  }

  private handleRateLimit(apiKey: string): void {
    this.keyPool.errorCounts[apiKey] = (this.keyPool.errorCounts[apiKey] || 0) + 1;
    this.keyPool.cooldowns[apiKey] = Date.now() + (this.config.cooldown || 60000);
    this.logger.warn(`Rate limit hit for key ${apiKey}, entering cooldown.`);
  }

  private selectNextKey(): string {
    const now = Date.now();
    while (this.keyPool.cooldowns[this.keyPool.keys[this.keyPool.currentIndex]] > now) {
      this.keyPool.currentIndex = (this.keyPool.currentIndex + 1) % this.keyPool.keys.length;
    }
    return this.keyPool.keys[this.keyPool.currentIndex];
  }

  public async fetchData(url: string): Promise<any> {
    const apiKey = this.selectNextKey();
    try {
      return await this.makeRequest(url, apiKey);
    } catch (error) {
      this.keyPool.currentIndex = (this.keyPool.currentIndex + 1) % this.keyPool.keys.length;
      return await this.fetchData(url); // Retry with next key
    }
  }
}

// src/config/bootstrap.ts

import { ProviderConfig } from './types';

export function loadConfig(): ProviderConfig {
  const config: ProviderConfig = {
    apiKeys: process.env.API_KEYS ? process.env.API_KEYS.split(',') : [],
    cooldown: parseInt(process.env.COOLDOWN || '60000', 10),
  };
  return config;
}

// tests/consumer.test.ts

import { Provider, ProviderConfig } from '../src/provider/index';
import { Logger } from '../src/logger';
import axios from 'axios';
import { jest } from '@jest/globals';

jest.mock('axios');

describe('Provider', () => {
  let provider: Provider;
  const logger = new Logger();

  beforeEach(() => {
    const config: ProviderConfig = {
      apiKeys: ['key1', 'key2', 'key3'],
      cooldown: 60000,
    };
    provider = new Provider(config, logger);
  });

  it('should rotate keys on rate limit', async () => {
    const mockResponse = { data: 'mock data' };
    const mockError = { response: { status: 429 } };

    (axios.get as jest.Mock).mockImplementationOnce(() => Promise.reject(mockError))
                          .mockImplementationOnce(() => Promise.resolve(mockResponse));

    await expect(provider.fetchData('https://api.example.com/data')).resolves.toEqual(mockResponse);
  });

  it('should handle all keys exhausted', async () => {
    const mockError = { response: { status: 429 } };

    (axios.get as jest.Mock).mockImplementation(() => Promise.reject(mockError));

    await expect(provider.fetchData('https://api.example.com/data')).rejects.toThrow('All keys exhausted');
  });

  it('should respect cooldown period', async () => {
    const mockResponse = { data: 'mock data' };
    const mockError = { response: { status: 429 } };

    (axios.get as jest.Mock).mockImplementationOnce(() => Promise.reject(mockError))
                          .mockImplementationOnce(() => Promise.reject(mockError))
                          .mockImplementationOnce(() => Promise.resolve(mockResponse));

    await expect(provider.fetchData('https://api.example.com/data')).resolves.toEqual(mockResponse);
  });
});