import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mounts, resolveRequest, parseRange } from '../library-server.mjs';
import { resolveWorkspaceDir, resolveSoundfontsDir } from './workspace-config.mjs';

const folders = { workspace: path.resolve('/music/ws'), stock: path.resolve('/lmms/samples'), library: path.resolve('/libs') };

test('requests map to the three folders and cannot leave them', () => {
  assert.equal(resolveRequest('/', folders), path.join(folders.workspace, 'sound-library.html'));
  assert.equal(resolveRequest('/latin-perc/Conga%20%231.wav', folders), path.join(folders.workspace, 'latin-perc', 'Conga #1.wav'));
  assert.equal(resolveRequest('/_stock/drums/kick01.ogg?x=1', folders), null, 'strict mode blocks /_stock/');
  assert.equal(
    resolveRequest('/_stock/drums/kick01.ogg?x=1', folders, { env: { LMMS_STRICT_COPYRIGHT: '0' } }),
    path.join(folders.stock, 'drums', 'kick01.ogg'),
  );
  assert.equal(resolveRequest('/_lib/VSCO2-trumpet/a.wav', folders), path.join(folders.library, 'VSCO2-trumpet', 'a.wav'));
  assert.equal(resolveRequest('/_stock/../../secret.txt', folders, { env: { LMMS_STRICT_COPYRIGHT: '0' } }), null);
  assert.equal(resolveRequest('/..%2F..%2Fsecret.txt', folders), null);
  assert.equal(resolveRequest('/_lib/%2e%2e/%2e%2e/x', folders), null);
  assert.equal(resolveRequest('/.lmms-taste.json', folders), null);
  assert.equal(resolveRequest('/%E0%A4%A', folders), null);
  assert.equal(resolveRequest('/_lib/a.wav', { ...folders, library: null }), null);
});

test('byte ranges are read the way browsers send them', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=5000-', 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
});

test('library-server mounts agree with workspace-config defaults', () => {
  const m = mounts({});
  assert.equal(m.workspace, resolveWorkspaceDir({}));
  assert.equal(m.soundfonts, resolveSoundfontsDir({}));
  assert.equal(m.stock, null, 'strict mode disables stock sample mount');
  assert.ok(mounts({ LMMS_STRICT_COPYRIGHT: '0' }).stock, 'non-strict mode mounts stock samples');
});
