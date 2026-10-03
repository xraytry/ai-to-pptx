import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('npm start serves the built static export without exposing source metadata', { timeout: 30000 }, async () => {
  const root = process.cwd();
  await access(resolve(root, 'webroot/index.html'));
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.start, 'serve webroot --no-clipboard');
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn('npm', ['start', '--', '--listen', `tcp://127.0.0.1:${port}`, '--no-port-switching'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', NODE_ENV: 'production' },
    detached: true,
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  try {
    let response;
    for (let i = 0; i < 100; i++) {
      assert.equal(spawnFailed, false, 'start command failed to spawn');
      assert.equal(child.exitCode, null, 'start command exited before HTTP readiness');
      try { response = await fetch(origin, { signal: AbortSignal.timeout(500) }); } catch {}
      if (response?.status === 200) break;
      await delay(100);
    }
    assert.equal(response?.status, 200, 'exported homepage is reachable');
    const html = await response.text();
    assert.match(html, /<html[\s>]/i);
    const asset = html.match(/(?:src|href)=["']([^"']*\/_next\/static\/[^"']+)["']/)?.[1];
    assert.ok(asset, 'real exported homepage links a Next static asset');
    const assetUrl = new URL(asset, origin);
    assert.equal(assetUrl.origin, origin, 'static asset is local');
    const assetResponse = await fetch(assetUrl, { signal: AbortSignal.timeout(2000) });
    assert.equal(assetResponse.status, 200);
    assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);
    const sourceMetadata = await fetch(new URL('/.git/config', origin), { signal: AbortSignal.timeout(2000) });
    assert.equal(sourceMetadata.status, 404, 'the source repository is outside the served directory');
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exited, delay(1500)]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
});
