// Update detection and notification popup controller
const DISMISSED_VERSION_KEY = 'gt_dismissed_update_version';

export function createUpdateController({
  document = globalThis.document,
  request = globalThis.fetch,
  clipboard = globalThis.navigator?.clipboard,
  storage = globalThis.localStorage,
  delayMs = 1200,
} = {}) {
  if (!document) return null;

  const $ = id => document.getElementById(id);
  const badge = $('update-badge');
  const badgeLabel = $('update-badge-label');
  const dialog = $('update-dialog');
  const closeBtn = $('update-close');
  const dismissBtn = $('update-dismiss');
  const title = $('update-title');
  const currentTag = $('update-current-tag');
  const latestTag = $('update-latest-tag');
  const changelog = $('update-changelog');
  const promptText = $('update-prompt-text');
  const copyBtn = $('update-copy-button');
  const copyLabel = $('update-copy-label');
  const skipCheckbox = $('update-skip-version');
  const releaseLink = $('update-release-link');

  let latestData = null;
  let copyResetTimer = null;

  function renderData(data) {
    latestData = data;
    const cleanCurrent = String(data.currentVersion || '').replace(/^v/i, '');
    const cleanLatest = String(data.latestVersion || '').replace(/^v/i, '');

    if (badgeLabel) {
      badgeLabel.textContent = `发现新版 v${cleanLatest}`;
    }
    if (badge) {
      badge.hidden = false;
    }
    if (title && data.title) {
      title.textContent = data.title;
    }
    if (currentTag) {
      currentTag.textContent = `当前 v${cleanCurrent}`;
    }
    if (latestTag) {
      latestTag.textContent = `最新 v${cleanLatest}`;
    }
    if (releaseLink && data.releaseUrl) {
      releaseLink.href = data.releaseUrl;
    }
    if (promptText) {
      promptText.value = data.upgradePrompt || '';
    }
    if (changelog) {
      changelog.innerHTML = '';
      const items = Array.isArray(data.changelog) && data.changelog.length > 0
        ? data.changelog
        : ['功能优化与打印仿真画质提升'];
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        changelog.appendChild(li);
      }
    }
    if (skipCheckbox) {
      try {
        const dismissed = storage?.getItem(DISMISSED_VERSION_KEY);
        skipCheckbox.checked = dismissed === data.latestVersion;
      } catch {
        skipCheckbox.checked = false;
      }
    }
  }

  function openDialog() {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else if (typeof dialog.show === 'function') {
      if (!dialog.open) dialog.show();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeDialog() {
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  async function copyPrompt() {
    const text = promptText?.value || latestData?.upgradePrompt || '';
    if (!text) return;

    let copied = false;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (!copied && promptText) {
      try {
        promptText.focus();
        promptText.select();
        copied = document.execCommand?.('copy') || false;
      } catch {
        copied = false;
      }
    }

    if (copyLabel) {
      clearTimeout(copyResetTimer);
      copyLabel.textContent = copied ? '✓ 已复制！发给 AI 即可自动升级' : '已全选，请按 Ctrl+C / Cmd+C 复制';
      copyResetTimer = setTimeout(() => {
        if (copyLabel) copyLabel.textContent = '复制升级指令给 AI';
      }, 3000);
    }
  }

  function onSkipChanged() {
    if (!skipCheckbox || !latestData?.latestVersion) return;
    try {
      if (skipCheckbox.checked) {
        storage?.setItem(DISMISSED_VERSION_KEY, latestData.latestVersion);
      } else {
        storage?.removeItem(DISMISSED_VERSION_KEY);
      }
    } catch {
      // Storage access blocked or quota exceeded
    }
  }

  // Event bindings
  if (badge) {
    badge.addEventListener('click', () => {
      openDialog();
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDialog);
  }
  if (dismissBtn) {
    dismissBtn.addEventListener('click', closeDialog);
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', copyPrompt);
  }
  if (skipCheckbox) {
    skipCheckbox.addEventListener('change', onSkipChanged);
  }

  async function check({ force = false, autoOpen = true } = {}) {
    try {
      const url = '/api/version/check' + (force ? '?force=true' : '');
      const response = await request(url);
      if (!response.ok) return null;
      const data = await response.json();
      if (data?.ok && data.hasUpdate) {
        renderData(data);
        if (autoOpen) {
          let dismissed = false;
          try {
            dismissed = storage?.getItem(DISMISSED_VERSION_KEY) === data.latestVersion;
          } catch {
            dismissed = false;
          }
          if (!dismissed) {
            openDialog();
          }
        }
      }
      return data;
    } catch {
      // Offline or network error: never throw or block UI
      return null;
    }
  }

  function start() {
    if (delayMs > 0) {
      setTimeout(() => {
        void check({ force: false, autoOpen: true });
      }, delayMs);
    } else {
      void check({ force: false, autoOpen: true });
    }
  }

  return {
    check,
    start,
    openDialog,
    closeDialog,
    copyPrompt,
    getLatestData: () => latestData,
  };
}

// Auto-instantiate when running directly in the browser
if (typeof document !== 'undefined') {
  const controller = createUpdateController();
  if (controller) {
    controller.start();
  }
}
