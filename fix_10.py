// tests/e2e.test.ts

import { expect } from 'chai';
import { setupTestEnvironment, teardownTestEnvironment } from './setup';
import { startRelay, startProvider, startConsumer } from '../src/cli';
import { sleep } from '../src/utils';

describe('E2E Tests', () => {
  let relayProcess: any;
  let providerProcess: any;
  let consumerProcess: any;

  beforeEach(async () => {
    await setupTestEnvironment();
    relayProcess = await startRelay();
    providerProcess = await startProvider();
  });

  afterEach(async () => {
    await teardownTestEnvironment();
    if (relayProcess) relayProcess.kill();
    if (providerProcess) providerProcess.kill();
    if (consumerProcess) consumerProcess.kill();
  });

  it('should handle auth failure with bad signing key', async () => {
    // Start consumer with a bad signing key
    consumerProcess = await startConsumer({ signingKey: 'invalid-key' });

    // Wait for consumer to attempt connection
    await sleep(2000);

    // Check if consumer received an error
    expect(consumerProcess.stderr).to.include('Authentication failed');
  });

  it('should handle provider offline scenario', async () => {
    // Kill provider process
    providerProcess.kill();

    // Start consumer
    consumerProcess = await startConsumer();

    // Wait for consumer to attempt connection
    await sleep(2000);

    // Check if consumer received an error
    expect(consumerProcess.stderr).to.include('Provider is offline');
  });

  it('should verify encryption and prevent plaintext prompt', async () => {
    // Start consumer
    consumerProcess = await startConsumer();

    // Wait for consumer to send encrypted prompt
    await sleep(2000);

    // Check if relay received encrypted data
    expect(relayProcess.stdout).to.include('Encrypted prompt received');
    expect(relayProcess.stdout).to.not.include('plaintext prompt');
  });

  it('should handle streaming SSE chunks end-to-end', async () => {
    // Start consumer
    consumerProcess = await startConsumer();

    // Wait for consumer to receive streaming data
    await sleep(5000);

    // Check if consumer received streaming data
    expect(consumerProcess.stdout).to.include('Streaming data received');
  });
});