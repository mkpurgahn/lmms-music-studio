import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, formatLogLine, resolveLogLevel } from './logger.mjs';

test('resolveLogLevel normalizes LMMS_LOG_LEVEL and defaults to info', () => {
  assert.equal(resolveLogLevel({}), 'info');
  assert.equal(resolveLogLevel({ LMMS_LOG_LEVEL: 'DEBUG' }), 'debug');
  assert.equal(resolveLogLevel({ LMMS_LOG_LEVEL: 'warn' }), 'warn');
  assert.equal(resolveLogLevel({ LMMS_LOG_LEVEL: 'unknown' }), 'info');
});

test('createLogger formats [ISO] [LEVEL] [component] message {meta} and filters by level', () => {
  const lines = [];
  const fakeStderr = { write: chunk => lines.push(chunk) };
  const fixedNow = () => new Date('2026-11-26T15:00:00.000Z');
  const logger = createLogger('render-engine', {
    env: { LMMS_LOG_LEVEL: 'info' },
    stream: fakeStderr,
    now: fixedNow,
  });

  assert.equal(logger.debug('ignored debug'), false);
  assert.equal(logger.info('Render started', { project: 'song.mmp', bars: 8 }), true);
  assert.equal(logger.error('Render failed', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), true);

  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    '[2026-11-26T15:00:00.000Z] [INFO] [render-engine] Render started {"project":"song.mmp","bars":8}\n',
  );
  assert.match(lines[1], /^\[2026-11-26T15:00:00\.000Z\] \[ERROR\] \[render-engine\] Render failed \{"error":"timeout","code":"ETIMEDOUT"/);
});

test('createLogger refuses process.stdout to protect MCP JSON-RPC transport', () => {
  assert.throws(
    () => createLogger('bad', { stream: process.stdout }),
    /must never write to process\.stdout/,
  );
  assert.equal(
    formatLogLine('warn', 'cfg', 'No meta', undefined, new Date('2026-11-26T15:00:00.000Z')),
    '[2026-11-26T15:00:00.000Z] [WARN] [cfg] No meta',
  );
});
