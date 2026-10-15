import { readFileSync } from 'node:fs';
import { APP_VERSION } from './beta-activation.mjs';

const config = JSON.parse(readFileSync(process.env.GROWTH_BETA_CONFIG || new URL('./beta-config.json', import.meta.url), 'utf8'));

/**
 * Compare two semver-like version strings.
 * Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if a === b
 */
export function compareVersions(a, b) {
  const cleanA = String(a || '').trim().replace(/^v/i, '');
  const cleanB = String(b || '').trim().replace(/^v/i, '');
  if (cleanA === cleanB) return 0;

  const parse = v => {
    const [main, pre] = v.split('-');
    const parts = main.split('.').map(n => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    let preNum = Infinity;
    if (pre) {
      const match = pre.match(/(\d+)/);
      preNum = match ? parseInt(match[1], 10) : 0;
    }
    return { parts, isPre: Boolean(pre), preNum };
  };

  const pa = parse(cleanA), pb = parse(cleanB);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] > pb.parts[i]) return 1;
    if (pa.parts[i] < pb.parts[i]) return -1;
  }
  // If major.minor.patch are identical: release > pre-release (e.g. 1.2.0 > 1.2.0-beta.6)
  if (!pa.isPre && pb.isPre) return 1;
  if (pa.isPre && !pb.isPre) return -1;
  if (pa.isPre && pb.isPre) {
    if (pa.preNum > pb.preNum) return 1;
    if (pa.preNum < pb.preNum) return -1;
  }
  return 0;
}

export function defaultUpgradePrompt(targetVersion, repository = 'dashan914/growth-timelapse-studio') {
  const version = String(targetVersion || '').trim().replace(/^v/i, '');
  const tag = `v${version}`;
  return `请按 https://raw.githubusercontent.com/${repository}/${tag}/INSTALL_AGENT.md 的“老用户升级”，把“打印延时一键生成”升级到 ${version}。先找到原安装目录，保留授权、订单和导出作品；核验固定版本的外部安装清单与运行 ZIP 的 SHA256，再用平台安装器安装到原目录。确认旧服务属于这个安装后再停止，不要删除整个安装目录、解除绑定或重新激活。完成后检查版本、原付费解锁状态及模型预览，告诉我软件地址和原启动入口。`;
}

export function createVersionCheckService({
  currentVersion = APP_VERSION,
  serverUrl = config.serverUrl,
  fetchImpl = fetch,
  cacheTtlMs = 10 * 60 * 1000,
  timeoutMs = 4000,
  now = Date.now,
} = {}) {
  let cached = null;
  let cachedAt = 0;

  async function check({ force = false } = {}) {
    const timestamp = now();
    if (!force && cached && (timestamp - cachedAt < cacheTtlMs)) {
      return cached;
    }

    let remoteData = null;
    try {
      const url = new URL('/api/software-beta/version', serverUrl);
      url.searchParams.set('current', currentVersion);
      const response = await fetchImpl(url.href, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        remoteData = await response.json();
      }
    } catch {
      // Primary server query failed or timed out; will fall back or return offline state
    }

    // Fallback: try raw GitHub manifest if primary server did not provide version
    if (!remoteData?.latestVersion && !remoteData?.version) {
      try {
        const ghUrl = 'https://raw.githubusercontent.com/dashan914/growth-timelapse-studio/main/install-manifest.json';
        const ghResponse = await fetchImpl(ghUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (ghResponse.ok) {
          const manifest = await ghResponse.json();
          if (manifest?.release?.published && manifest?.release?.version) {
            remoteData = {
              latestVersion: manifest.release.version,
              releaseDate: manifest.release.releaseDate || null,
              releaseUrl: manifest.release.url || null,
              changelog: manifest.release.highlights || manifest.release.changelog || [],
            };
          }
        }
      } catch {
        // Fallback also unavailable
      }
    }

    if (!remoteData || (!remoteData.latestVersion && !remoteData.version)) {
      cached = {
        ok: true,
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        offline: true,
        checkedAt: timestamp,
      };
      cachedAt = timestamp;
      return cached;
    }

    const latestVersion = String(remoteData.latestVersion || remoteData.version).trim();
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    const upgradePrompt = remoteData.upgradePrompt || defaultUpgradePrompt(latestVersion);
    const changelog = Array.isArray(remoteData.changelog)
      ? remoteData.changelog
      : Array.isArray(remoteData.highlights)
        ? remoteData.highlights
        : [];

    cached = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      title: remoteData.title || `v${latestVersion.replace(/^v/i, '')} 更新可用`,
      releaseDate: remoteData.releaseDate || null,
      releaseUrl: remoteData.releaseUrl || `https://github.com/dashan914/growth-timelapse-studio/releases/tag/v${latestVersion.replace(/^v/i, '')}`,
      changelog,
      upgradePrompt,
      offline: false,
      checkedAt: timestamp,
    };
    cachedAt = timestamp;
    return cached;
  }

  function clearCache() {
    cached = null;
    cachedAt = 0;
  }

  return { check, clearCache, compareVersions, currentVersion };
}
