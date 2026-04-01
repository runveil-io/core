import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('logger', () => {
  let stdoutData: string[];
  let stderrData: string[];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  beforeEach(() => {
    stdoutData = [];
    stderrData = [];
    process.stdout.write = ((chunk: string) => { stdoutData.push(chunk); return true; }) as any;
    process.stderr.write = ((chunk: string) => { stderrData.push(chunk); return true; }) as any;
    // Force JSON output for predictable testing
    process.env.VEIL_LOG_FORMAT = 'json';
    delete process.env.VEIL_LOG_LEVEL;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    delete process.env.VEIL_LOG_FORMAT;
    delete process.env.VEIL_LOG_LEVEL;
  });

  it('outputs valid JSON', () => {
    const log = createLogger('test');
    log.info('hello');
    expect(stdoutData.length).toBe(1);
    const parsed = JSON.parse(stdoutData[0].trim());
    expect(parsed).toHaveProperty('ts');
    expect(parsed).toHaveProperty('level', 'info');
    expect(parsed).toHaveProperty('module', 'test');
    expect(parsed).toHaveProperty('msg', 'hello');
  });

  it('includes context fields in JSON', () => {
    const log = createLogger('net');
    log.warn('timeout', { port: 8080, retries: 3 });
    const parsed = JSON.parse(stdoutData[0].trim());
    expect(parsed.port).toBe(8080);
    expect(parsed.retries).toBe(3);
    expect(parsed.level).toBe('warn');
  });

  it('tags module correctly', () => {
    const log = createLogger('relay');
    log.info('started');
    const parsed = JSON.parse(stdoutData[0].trim());
    expect(parsed.module).toBe('relay');
  });

  it('writes errors to stderr', () => {
    const log = createLogger('proxy');
    log.error('fail', { code: 500 });
    expect(stdoutData.length).toBe(0);
    expect(stderrData.length).toBe(1);
    const parsed = JSON.parse(stderrData[0].trim());
    expect(parsed.level).toBe('error');
    expect(parsed.code).toBe(500);
  });

  it('filters by VEIL_LOG_LEVEL', () => {
    process.env.VEIL_LOG_LEVEL = 'warn';
    const log = createLogger('test');
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    expect(stdoutData.length).toBe(1); // warn
    expect(stderrData.length).toBe(1); // error
  });

  it('debug level shows all messages', () => {
    process.env.VEIL_LOG_LEVEL = 'debug';
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(stdoutData.length).toBe(3); // debug, info, warn
    expect(stderrData.length).toBe(1); // error
  });

  it('error level filters everything except errors', () => {
    process.env.VEIL_LOG_LEVEL = 'error';
    const log = createLogger('test');
    log.debug('no');
    log.info('no');
    log.warn('no');
    log.error('yes');
    expect(stdoutData.length).toBe(0);
    expect(stderrData.length).toBe(1);
  });

  it('ts is ISO 8601 format', () => {
    const log = createLogger('test');
    log.info('check');
    const parsed = JSON.parse(stdoutData[0].trim());
    expect(() => new Date(parsed.ts)).not.toThrow();
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
