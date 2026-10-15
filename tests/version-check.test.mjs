import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, defaultUpgradePrompt, createVersionCheckService } from '../version-check.mjs';

test('compareVersions handles standard and prerelease semver strings', () => {
  assert.equal(compareVersions('1.2.0-beta.7', '1.2.0-beta.6'), 1);
  assert.equal(compareVersions('1.2.0-beta.6', '1.2.0-beta.7'), -1);
  assert.equal(compareVersions('1.2.0-beta.6', '1.2.0-beta.6'), 0);
  assert.equal(compareVersions('v1.2.0-beta.7', '1.2.0-beta.6'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0-beta.6'), 1, 'release is higher than prerelease');
  assert.equal(compareVersions('1.2.0-beta.6', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.1', '1.2.0'), 1);
  assert.equal(compareVersions('1.3.0', '1.2.5'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('defaultUpgradePrompt generates standard INSTALL_AGENT.md prompt', () => {
  const prompt = defaultUpgradePrompt('1.2.0-beta.7');
  assert.match(prompt, /dashan914\/growth-timelapse-studio\/v1\.2\.0-beta\.7\/INSTALL_AGENT\.md/);
  assert.match(prompt, /老用户升级/);
  assert.match(prompt, /升级到 1\.2\.0-beta\.7/);
});

test('createVersionCheckService detects update when remote returns newer version', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      latestVersion: '1.2.0-beta.7',
      releaseDate: '2026-10-15',
      changelog: ['修复外墙错位', '4~6mm 内部光影'],
    }),
  });

  const service = createVersionCheckService({
    currentVersion: '1.2.0-beta.6',
    serverUrl: 'https://ai3dclass.cn',
    fetchImpl: mockFetch,
  });

  const result = await service.check();
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latestVersion, '1.2.0-beta.7');
  assert.equal(result.currentVersion, '1.2.0-beta.6');
  assert.equal(result.changelog.length, 2);
  assert.match(result.upgradePrompt, /v1\.2\.0-beta\.7/);
  assert.equal(result.offline, false);
});

test('createVersionCheckService reports no update when versions match', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      latestVersion: '1.2.0-beta.6',
    }),
  });

  const service = createVersionCheckService({
    currentVersion: '1.2.0-beta.6',
    serverUrl: 'https://ai3dclass.cn',
    fetchImpl: mockFetch,
  });

  const result = await service.check();
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, '1.2.0-beta.6');
});

test('createVersionCheckService handles offline/network failure gracefully without throwing', async () => {
  const mockFetch = async () => {
    throw new Error('Connection refused');
  };

  const service = createVersionCheckService({
    currentVersion: '1.2.0-beta.6',
    serverUrl: 'https://ai3dclass.cn',
    fetchImpl: mockFetch,
  });

  const result = await service.check();
  assert.equal(result.ok, true);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.offline, true);
  assert.equal(result.latestVersion, '1.2.0-beta.6');
});

test('createVersionCheckService caches result within cacheTtlMs', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({ latestVersion: '1.2.0-beta.7' }),
    };
  };

  let mockTime = 1000;
  const service = createVersionCheckService({
    currentVersion: '1.2.0-beta.6',
    serverUrl: 'https://ai3dclass.cn',
    fetchImpl: mockFetch,
    cacheTtlMs: 60000,
    now: () => mockTime,
  });

  await service.check();
  assert.equal(callCount, 1);

  mockTime += 30000;
  await service.check();
  assert.equal(callCount, 1, 'should use cache');

  mockTime += 40000;
  await service.check();
  assert.equal(callCount, 2, 'should re-fetch after TTL');
});
