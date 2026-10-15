import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateController } from '../src/update-check.js';

function createMockDocument() {
  const elements = new Map();

  function makeElement(id) {
    const el = {
      id,
      textContent: '',
      value: '',
      hidden: true,
      open: false,
      href: '',
      checked: false,
      listeners: {},
      children: [],
      innerHTML: '',
      addEventListener(event, fn) {
        this.listeners[event] = this.listeners[event] || [];
        this.listeners[event].push(fn);
      },
      dispatchEvent(event) {
        for (const fn of (this.listeners[event] || [])) fn();
      },
      showModal() { this.open = true; },
      show() { this.open = true; },
      close() { this.open = false; },
      appendChild(child) { this.children.push(child); },
      focus() {},
      select() {},
    };
    elements.set(id, el);
    return el;
  }

  // Set up elements used by update controller
  [
    'update-badge', 'update-badge-label', 'update-dialog', 'update-close',
    'update-dismiss', 'update-title', 'update-current-tag', 'update-latest-tag',
    'update-changelog', 'update-prompt-text', 'update-copy-button', 'update-copy-label',
    'update-skip-version', 'update-release-link',
  ].forEach(makeElement);

  return {
    getElementById: id => elements.get(id) || null,
    createElement: tag => ({
      tagName: tag.toUpperCase(),
      textContent: '',
    }),
  };
}

function createMockStorage() {
  const store = new Map();
  return {
    getItem: key => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: key => store.delete(key),
  };
}

test('update-check controller detects update and pops dialog', async () => {
  const doc = createMockDocument();
  const storage = createMockStorage();
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      currentVersion: '1.2.0-beta.6',
      latestVersion: '1.2.1',
      hasUpdate: true,
      title: 'v1.2.1 更新可用',
      releaseUrl: 'https://github.com/dashan914/growth-timelapse-studio/releases/tag/v1.2.1',
      changelog: ['全新更新检测', '4-6mm 内部光影'],
      upgradePrompt: '请升级到 1.2.1',
    }),
  });

  const controller = createUpdateController({
    document: doc,
    request: mockFetch,
    storage,
    delayMs: 0,
  });

  const data = await controller.check();
  assert.equal(data.hasUpdate, true);

  const badge = doc.getElementById('update-badge');
  const badgeLabel = doc.getElementById('update-badge-label');
  const dialog = doc.getElementById('update-dialog');
  const currentTag = doc.getElementById('update-current-tag');
  const latestTag = doc.getElementById('update-latest-tag');
  const promptText = doc.getElementById('update-prompt-text');

  assert.equal(badge.hidden, false);
  assert.equal(badgeLabel.textContent, '发现新版 v1.2.1');
  assert.equal(dialog.open, true);
  assert.equal(currentTag.textContent, '当前 v1.2.0-beta.6');
  assert.equal(latestTag.textContent, '最新 v1.2.1');
  assert.equal(promptText.value, '请升级到 1.2.1');
});

test('update-check honors dismissed version and does not auto-open dialog', async () => {
  const doc = createMockDocument();
  const storage = createMockStorage();
  storage.setItem('gt_dismissed_update_version', '1.2.1');

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      currentVersion: '1.2.0-beta.6',
      latestVersion: '1.2.1',
      hasUpdate: true,
      upgradePrompt: '请升级到 1.2.1',
    }),
  });

  const controller = createUpdateController({
    document: doc,
    request: mockFetch,
    storage,
    delayMs: 0,
  });

  await controller.check();

  const badge = doc.getElementById('update-badge');
  const dialog = doc.getElementById('update-dialog');

  // Badge is shown so user can click it manually
  assert.equal(badge.hidden, false);
  // Dialog is NOT opened automatically
  assert.equal(dialog.open, false);

  // User manually clicks badge -> opens dialog
  badge.dispatchEvent('click');
  assert.equal(dialog.open, true);

  // User closes dialog
  const closeBtn = doc.getElementById('update-close');
  closeBtn.dispatchEvent('click');
  assert.equal(dialog.open, false);
});

test('copy button copies prompt and shows feedback', async () => {
  const doc = createMockDocument();
  let writtenText = '';
  const mockClipboard = {
    writeText: async text => { writtenText = text; },
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      currentVersion: '1.2.0-beta.6',
      latestVersion: '1.2.1',
      hasUpdate: true,
      upgradePrompt: '请升级到 1.2.1 并且保留数据',
    }),
  });

  const controller = createUpdateController({
    document: doc,
    request: mockFetch,
    clipboard: mockClipboard,
    delayMs: 0,
  });

  await controller.check();

  const copyBtn = doc.getElementById('update-copy-button');
  const copyLabel = doc.getElementById('update-copy-label');

  await controller.copyPrompt();
  assert.equal(writtenText, '请升级到 1.2.1 并且保留数据');
  assert.match(copyLabel.textContent, /已复制/);
});
