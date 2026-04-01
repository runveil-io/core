import { createWallet, loadWallet, getPublicKeys, encryptApiKey } from './wallet/index.js';
import { startGateway } from './consumer/index.js';
import { startProvider } from './provider/index.js';
import { startRelay } from './relay/index.js';
import { DEFAULT_GATEWAY_PORT, DEFAULT_RELAY_PORT, OFFICIAL_RELAY_URL, MODEL_MAP } from './config/bootstrap.js';
import { loadAndValidateConfig, loadAndValidateProviderConfig } from './config/validator.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

function getVeilHome(): string {
  return process.env['VEIL_HOME'] ?? join(process.env['HOME'] ?? '.', '.veil');
}

async function promptPassword(prompt: string): Promise<string> {
  // Allow env var to skip interactive prompt (for CI/systemd/testing)
  if (process.env.VEIL_PASSWORD) return process.env.VEIL_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function cmdInit(): Promise<void> {
  const home = getVeilHome();
  const force = process.argv.includes('--force');

  if (existsSync(join(home, 'wallet.json')) && !force) {
    console.error('Already initialized. Use --force to reinitialize.');
    process.exit(1);
  }

  const password = await promptPassword('Password (min 8 chars): ');

  try {
    const info = await createWallet(password, home);
    const pk = info.signingPublicKey;
    console.log(`Veil initialized.`);
    console.log(`Public key: ${pk.slice(0, 8)}...${pk.slice(-8)}`);
    console.log(`Gateway:    http://localhost:${DEFAULT_GATEWAY_PORT}/v1`);
    console.log(`Relay:      ${OFFICIAL_RELAY_URL}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

async function cmdProvideInit(): Promise<void> {
  const home = getVeilHome();

  if (!existsSync(join(home, 'wallet.json'))) {
    console.error("Run 'veil init' first.");
    process.exit(1);
  }

  const apiKeyInput = await promptPassword('Anthropic API key: ');

  // Validate API key
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKeyInput, 'anthropic-version': '2023-06-01' },
    });
    if (res.status === 401) {
      console.error('Invalid API key.');
      process.exit(1);
    }
  } catch {
    console.error('Cannot reach Anthropic API. Check network.');
    process.exit(1);
  }

  const password = await promptPassword('Wallet password: ');
  // Verify password by loading wallet
  try {
    await loadWallet(password, home);
  } catch {
    console.error('Wrong password.');
    process.exit(1);
  }

  const encrypted = encryptApiKey(apiKeyInput, password);
  const models = Object.keys(MODEL_MAP);

  const providerConfig = {
    version: 1,
    models,
    api_keys: [{ provider: 'anthropic', ...encrypted }],
    max_concurrent: 5,
    self_priority: true,
  };

  writeFileSync(join(home, 'provider.json'), JSON.stringify(providerConfig, null, 2), { mode: 0o600 });

  console.log('Provider initialized.');
  console.log(`Models: ${models.join(', ')}`);
  console.log('Max concurrent: 5');
}

async function cmdProvideStart(): Promise<void> {
  const home = getVeilHome();
  const password = await promptPassword('Wallet password: ');

  const wallet = await loadWallet(password, home);

  // Validate configs at startup (fixes #6)
  let config: Record<string, unknown>;
  let providerConfig: Record<string, unknown>;
  try {
    config = loadAndValidateConfig(home);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  try {
    providerConfig = loadAndValidateProviderConfig(home);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Decrypt API keys, fallback to env
  const apiKeys: Array<{ provider: 'anthropic'; key: string }> = [];

  for (const enc of providerConfig.api_keys) {
    try {
      const { decryptApiKey } = await import('./wallet/index.js');
      const key = decryptApiKey(enc, password);
      apiKeys.push({ provider: enc.provider, key });
    } catch {
      // Try env fallback
      const envKey = process.env['ANTHROPIC_API_KEY'];
      if (envKey) {
        apiKeys.push({ provider: 'anthropic', key: envKey });
      }
    }
  }

  if (apiKeys.length === 0 && process.env['ANTHROPIC_API_KEY']) {
    apiKeys.push({ provider: 'anthropic', key: process.env['ANTHROPIC_API_KEY'] });
  }

  if (apiKeys.length === 0) {
    console.error('No API keys available.');
    process.exit(1);
  }

  const relayUrl = config.relay_url ?? OFFICIAL_RELAY_URL;
  const provider = await startProvider({
    wallet,
    relayUrl,
    apiKeys,
    maxConcurrent: providerConfig.max_concurrent ?? 5,
    proxyUrl: process.env.PROXY_URL,        // e.g. http://127.0.0.1:4000
    proxySecret: process.env.PROXY_SECRET,  // shared secret from proxy
  });

  console.log('Provider online.');
  console.log(`Models: ${providerConfig.models.join(', ')}`);
  console.log(`Relay:  ${relayUrl}`);
  console.log('Waiting for requests...');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await provider.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await provider.close();
    process.exit(0);
  });
}

async function cmdRelayStart(): Promise<void> {
  const home = getVeilHome();
  const password = await promptPassword('Wallet password: ');
  const wallet = await loadWallet(password, home);

  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env['VEIL_RELAY_PORT'] ?? DEFAULT_RELAY_PORT);

  const dbArg = process.argv.indexOf('--db');
  const dbPath = dbArg !== -1 ? process.argv[dbArg + 1]! : join(home, 'data', 'usage.db');

  const relay = await startRelay({ port, wallet, dbPath });

  console.log('Relay online.');
  console.log(`Listening: ws://0.0.0.0:${port}`);
  console.log('Providers: 0 connected');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await relay.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await relay.close();
    process.exit(0);
  });
}

async function cmdStatus(): Promise<void> {
  const home = getVeilHome();

  // Validate config at startup (fixes #6)
  let config: Record<string, unknown>;
  try {
    config = loadAndValidateConfig(home);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const pk = config.consumer_pubkey as string;

  // Check gateway
  let gatewayStatus = 'stopped';
  try {
    const res = await fetch(`http://localhost:${config.gateway_port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) gatewayStatus = 'running';
  } catch { /* stopped */ }

  // Check relay
  let relayStatus = 'unreachable';
  try {
    const { WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(config.relay_url);
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        relayStatus = 'connected';
        resolve();
      });
      ws.on('error', () => { clearTimeout(timer); reject(new Error('error')); });
    });
  } catch { /* unreachable */ }

  // Check provider
  const providerPath = join(home, 'provider.json');
  const providerStatus = existsSync(providerPath) ? 'configured' : 'not configured';

  console.log('Veil Status');
  console.log('-----------');
  console.log(`Public key:   ${pk.slice(0, 8)}...${pk.slice(-8)}`);
  console.log(`Gateway:      http://localhost:${config.gateway_port} [${gatewayStatus}]`);
  console.log(`Relay:        ${config.relay_url} [${relayStatus}]`);
  console.log(`Provider:     [${providerStatus}]`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'init':
      await cmdInit();
      break;
    case 'provide':
      if (args[1] === 'init') await cmdProvideInit();
      else if (args[1] === 'start') await cmdProvideStart();
      else {
        console.error('Usage: veil provide [init|start]');
        process.exit(1);
      }
      break;
    case 'relay':
      if (args[1] === 'start') await cmdRelayStart();
      else {
        console.error('Usage: veil relay start [--port 8080]');
        process.exit(1);
      }
      break;
    case 'status':
      await cmdStatus();
      break;
    default:
      console.log('Usage: veil <command>');
      console.log('');
      console.log('Commands:');
      console.log('  init            Initialize Veil wallet');
      console.log('  provide init    Configure as Provider');
      console.log('  provide start   Start Provider');
      console.log('  relay start     Start Relay server');
      console.log('  status          Check status');
      break;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
