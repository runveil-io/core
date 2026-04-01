import { createWallet, loadWallet, getPublicKeys, encryptApiKey } from './wallet/index.js';
import { startGateway } from './consumer/index.js';
import { startProvider } from './provider/index.js';
import { startRelay } from './relay/index.js';
import { DEFAULT_GATEWAY_PORT, DEFAULT_RELAY_PORT, OFFICIAL_RELAY_URL, MODEL_MAP } from './config/bootstrap.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { styleText } from 'node:util';
import { stdout as output } from 'node:process';

// ============== CLI Utilities ==============

// Check if we should use colors (NO_COLOR support)
function shouldUseColors(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return output.isTTY ?? false;
}

// Color helper - only apply colors if enabled
function color(text: string, colorName: string): string {
  if (!shouldUseColors()) return text;
  try {
    return styleText(colorName, text);
  } catch {
    return text;
  }
}

const colors = {
  success: (t: string) => color(t, 'green'),
  error: (t: string) => color(t, 'red'),
  warning: (t: string) => color(t, 'yellow'),
  info: (t: string) => color(t, 'cyan'),
  dim: (t: string) => color(t, 'gray'),
  bold: (t: string) => color(t, 'bold'),
};

// Simple spinner for loading animations
class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private interval: NodeJS.Timeout | null = null;
  private message: string;
  private frameIndex = 0;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    if (!output.isTTY || !shouldUseColors()) {
      output.write(`${this.message}...\n`);
      return;
    }
    output.write(`${this.frames[0]} ${this.message}`);
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      output.write(`\r${this.frames[this.frameIndex]} ${this.message}`);
    }, 80);
  }

  stop(finalMessage?: string, success: boolean = true): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (output.isTTY && shouldUseColors()) {
      output.write('\r');
      output.write(' '.repeat(this.message.length + 10));
      output.write('\r');
    }
    const icon = success ? colors.success('✓') : colors.error('✗');
    const msg = finalMessage ?? this.message;
    output.write(`${icon} ${msg}\n`);
  }

  update(message: string): void {
    this.message = message;
    if (output.isTTY && shouldUseColors() && this.interval) {
      output.write(`\r${this.frames[this.frameIndex]} ${message}`);
    }
  }
}

// Table formatter for status output
function formatTable(rows: string[][], headers?: string[]): string {
  if (rows.length === 0) return '';
  
  // Calculate column widths
  const allRows = headers ? [headers, ...rows] : rows;
  const colWidths = allRows.reduce((widths, row) => {
    row.forEach((cell, i) => {
      // Strip ANSI codes for width calculation
      const cleanCell = cell.replace(/\x1b\[[0-9;]*m/g, '');
      widths[i] = Math.max(widths[i] || 0, cleanCell.length);
    });
    return widths;
  }, [] as number[]);

  // Format rows
  const formatRow = (row: string[]): string => {
    return row.map((cell, i) => {
      const cleanCell = cell.replace(/\x1b\[[0-9;]*m/g, '');
      const padding = ' '.repeat((colWidths[i] || 0) - cleanCell.length);
      return cell + padding;
    }).join('  ');
  };

  let result = '';
  if (headers) {
    result += formatRow(headers) + '\n';
    result += colors.dim('─'.repeat(colWidths.reduce((a, b) => a + b + 2, -2))) + '\n';
  }
  result += rows.map(formatRow).join('\n');
  return result;
}

// ============== Core Functions ==============

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
    console.error(colors.error('Already initialized. Use --force to reinitialize.'));
    process.exit(1);
  }

  output.write(colors.info('Initializing Veil wallet...\n\n'));

  const password = await promptPassword('Password (min 8 chars): ');

  const spinner = new Spinner('Generating wallet');
  spinner.start();

  try {
    await new Promise(resolve => setTimeout(resolve, 500)); // Minimum spinner display
    const info = await createWallet(password, home);
    const pk = info.signingPublicKey;
    
    spinner.stop('Wallet generated', true);
    
    output.write('\n');
    output.write(colors.success('✓ Veil initialized successfully!\n\n'));
    output.write(colors.dim('Configuration:\n'));
    output.write(`  ${colors.bold('Public key:')}  ${colors.info(pk.slice(0, 8) + '...' + pk.slice(-8))}\n`);
    output.write(`  ${colors.bold('Gateway:')}     ${colors.info(`http://localhost:${DEFAULT_GATEWAY_PORT}/v1`)}\n`);
    output.write(`  ${colors.bold('Relay:')}       ${colors.info(OFFICIAL_RELAY_URL)}\n`);
    output.write('\n');
    output.write(colors.dim('Next steps:\n'));
    output.write(`  1. Run ${colors.info('veil status')} to check connection\n`);
    output.write(`  2. Run ${colors.info('veil provide init')} to configure as provider\n`);
  } catch (err) {
    spinner.stop('Failed to create wallet', false);
    console.error(colors.error((err as Error).message));
    process.exit(1);
  }
}

async function cmdProvideInit(): Promise<void> {
  const home = getVeilHome();

  if (!existsSync(join(home, 'wallet.json'))) {
    console.error(colors.error("Run 'veil init' first."));
    process.exit(1);
  }

  output.write(colors.info('Configuring Veil Provider...\n\n'));

  const apiKeyInput = await promptPassword('Anthropic API key: ');

  const spinner = new Spinner('Validating API key');
  spinner.start();

  // Validate API key
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKeyInput, 'anthropic-version': '2023-06-01' },
    });
    if (res.status === 401) {
      spinner.stop('Invalid API key', false);
      process.exit(1);
    }
    spinner.stop('API key validated', true);
  } catch {
    spinner.stop('Cannot reach Anthropic API', false);
    console.error(colors.error('Check network connection.'));
    process.exit(1);
  }

  const password = await promptPassword('Wallet password: ');
  
  spinner.start('Verifying wallet');
  // Verify password by loading wallet
  try {
    await loadWallet(password, home);
    spinner.stop('Wallet verified', true);
  } catch {
    spinner.stop('Wrong password', false);
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

  output.write('\n');
  output.write(colors.success('✓ Provider initialized!\n\n'));
  output.write(colors.dim('Configuration:\n'));
  output.write(`  ${colors.bold('Models:')}         ${colors.info(models.join(', '))}\n`);
  output.write(`  ${colors.bold('Max concurrent:')} ${colors.info('5')}\n`);
  output.write(`  ${colors.bold('Priority:')}       ${colors.info('Self (highest)')}\n`);
}

async function cmdProvideStart(): Promise<void> {
  const home = getVeilHome();
  const password = await promptPassword('Wallet password: ');

  const spinner = new Spinner('Loading wallet');
  spinner.start();

  const wallet = await loadWallet(password, home);
  spinner.stop('Wallet loaded', true);

  const providerPath = join(home, 'provider.json');
  if (!existsSync(providerPath)) {
    console.error(colors.error("Run 'veil provide init' first."));
    process.exit(1);
  }

  const providerConfig = JSON.parse(readFileSync(providerPath, 'utf-8'));
  const configPath = join(home, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

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
    console.error(colors.error('No API keys available.'));
    process.exit(1);
  }

  const relayUrl = config.relay_url ?? OFFICIAL_RELAY_URL;
  
  spinner.start('Connecting to relay');
  const provider = await startProvider({
    wallet,
    relayUrl,
    apiKeys,
    maxConcurrent: providerConfig.max_concurrent ?? 5,
    proxyUrl: process.env.PROXY_URL,
    proxySecret: process.env.PROXY_SECRET,
  });
  spinner.stop('Connected to relay', true);

  output.write('\n');
  output.write(colors.success('✓ Provider online!\n\n'));
  output.write(colors.dim('Status:\n'));
  output.write(`  ${colors.bold('Models:')}     ${colors.info(providerConfig.models.join(', '))}\n`);
  output.write(`  ${colors.bold('Relay:')}      ${colors.info(relayUrl)}\n`);
  output.write(`  ${colors.bold('Status:')}     ${colors.success('Waiting for requests...')}\n`);

  process.on('SIGINT', async () => {
    output.write('\n');
    output.write(colors.warning('Shutting down provider...\n'));
    await provider.close();
    output.write(colors.success('Provider stopped.\n'));
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
  
  const spinner = new Spinner('Loading wallet');
  spinner.start();
  const wallet = await loadWallet(password, home);
  spinner.stop('Wallet loaded', true);

  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env['VEIL_RELAY_PORT'] ?? DEFAULT_RELAY_PORT);

  const dbArg = process.argv.indexOf('--db');
  const dbPath = dbArg !== -1 ? process.argv[dbArg + 1]! : join(home, 'data', 'usage.db');

  const relay = await startRelay({ port, wallet, dbPath });

  output.write('\n');
  output.write(colors.success('✓ Relay online!\n\n'));
  output.write(colors.dim('Listening:\n'));
  output.write(`  ${colors.bold('WebSocket:')}  ${colors.info(`ws://0.0.0.0:${port}`)}\n`);
  output.write(`  ${colors.bold('Providers:')}  ${colors.success('0 connected')}\n`);

  process.on('SIGINT', async () => {
    output.write('\n');
    output.write(colors.warning('Shutting down relay...\n'));
    await relay.close();
    output.write(colors.success('Relay stopped.\n'));
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await relay.close();
    process.exit(0);
  });
}

async function cmdStatus(): Promise<void> {
  const home = getVeilHome();
  const configPath = join(home, 'config.json');

  if (!existsSync(configPath)) {
    console.error(colors.error("Not initialized. Run 'veil init'."));
    process.exit(1);
  }

  const spinner = new Spinner('Checking status');
  spinner.start();

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const pk = config.consumer_pubkey;

  // Check gateway
  let gatewayStatus = 'stopped';
  let gatewayColor = colors.error;
  try {
    const res = await fetch(`http://localhost:${config.gateway_port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      gatewayStatus = 'running';
      gatewayColor = colors.success;
    }
  } catch { /* stopped */ }

  // Check relay
  let relayStatus = 'unreachable';
  let relayColor = colors.error;
  try {
    const { WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(config.relay_url);
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        relayStatus = 'connected';
        relayColor = colors.success;
        resolve();
      });
      ws.on('error', () => { clearTimeout(timer); reject(new Error('error')); });
    });
  } catch { /* unreachable */ }

  // Check provider
  const providerPath = join(home, 'provider.json');
  const providerStatus = existsSync(providerPath) ? 'configured' : 'not configured';
  const providerColor = existsSync(providerPath) ? colors.success : colors.warning;

  spinner.stop('Status check complete', true);

  output.write('\n');
  output.write(colors.bold('Veil Status\n'));
  output.write(colors.dim('─'.repeat(50)) + '\n');

  // Use table format
  const rows = [
    [colors.bold('Component'), colors.bold('Status'), colors.bold('Details')],
    ['Public Key', colors.info(pk.slice(0, 8) + '...' + pk.slice(-8)), ''],
    ['Gateway', gatewayColor(gatewayStatus), `http://localhost:${config.gateway_port}`],
    ['Relay', relayColor(relayStatus), config.relay_url],
    ['Provider', providerColor(providerStatus), providerPath],
  ];

  output.write(formatTable(rows.slice(1), rows[0]) + '\n');
  output.write('\n');
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
      output.write(colors.bold('Veil - Decentralized AI Inference Protocol\n\n'));
      output.write(colors.dim('Usage: veil <command>\n\n'));
      output.write(colors.bold('Commands:\n'));
      output.write(`  ${colors.info('init')}            Initialize Veil wallet\n`);
      output.write(`  ${colors.info('provide init')}    Configure as Provider\n`);
      output.write(`  ${colors.info('provide start')}   Start Provider\n`);
      output.write(`  ${colors.info('relay start')}     Start Relay server\n`);
      output.write(`  ${colors.info('status')}          Check status\n`);
      break;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
