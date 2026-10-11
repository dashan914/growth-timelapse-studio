// Source files stay in this browser's IndexedDB. Each field has its own record
// so moving a model or changing a setting never rewrites a large 3MF or G-code.
export const SOURCE_BLOB_LIMIT = 512 * 1024 * 1024;

const DATABASE_NAME = 'growth-timelapse-studio';
const STORE_NAME = 'project';
const SIZE_KEY = '__sourceBytes';
const SOURCE_KEYS = ['modelFiles', 'backgroundFile', 'referenceFile', 'supportGcode', 'supportFile'];
const PROJECT_KEYS = [...SOURCE_KEYS, 'backgroundPreset', 'settings', 'camera'];
let databasePromise;

function isBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function sourceSize(key, value) {
  if (key === 'modelFiles') return value.reduce((sum, file) => sum + file.size, 0);
  if (key === 'supportGcode') return value == null ? 0 : new Blob([value]).size;
  return value?.size || 0;
}

/** Validate a partial update without accessing IndexedDB or mutating its input. */
export function validateCachePatch(patch, previousSourceBytes = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('项目缓存更新必须是对象。');
  }
  const sourceBytes = Object.fromEntries(SOURCE_KEYS.map(key => [key, Number(previousSourceBytes[key]) || 0]));
  for (const key of Object.keys(patch)) {
    if (!PROJECT_KEYS.includes(key)) throw new TypeError(`不支持的项目缓存字段：${key}`);
    const value = patch[key];
    if (value === undefined) continue;
    if (key === 'modelFiles' && (!Array.isArray(value) || value.some(file => !isBlob(file)))) {
      throw new TypeError('模型缓存需要一个文件数组。');
    }
    if ((key === 'backgroundFile' || key === 'referenceFile' || key === 'supportFile') && value !== null && !isBlob(value)) {
      throw new TypeError('背景和对照照片缓存需要文件或 null。');
    }
    if ((key === 'supportGcode' || key === 'backgroundPreset') && value !== null && typeof value !== 'string') {
      throw new TypeError('支撑代码和背景预设缓存需要文字或 null。');
    }
    if ((key === 'settings' || key === 'camera') && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw new TypeError('设置和相机缓存需要对象或 null。');
    }
    if (SOURCE_KEYS.includes(key)) sourceBytes[key] = sourceSize(key, value);
  }
  const totalSourceBytes = Object.values(sourceBytes).reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(totalSourceBytes) || totalSourceBytes > SOURCE_BLOB_LIMIT) {
    throw new RangeError('本地项目素材超过 512 MiB 缓存预算，当前画面仍可使用；刷新后需重新选择未保存的素材。');
  }
  return { sourceBytes, totalSourceBytes };
}

function wrapFile(file) {
  if (file == null) return null;
  return {
    blob: file,
    name: typeof file.name === 'string' ? file.name : '未命名文件',
    type: file.type || '',
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
  };
}

/** Browsers may restore a File as a Blob; keep its original import metadata. */
export function normalizeFile(record) {
  if (record == null) return null;
  const blob = isBlob(record) ? record : record.blob;
  if (!isBlob(blob)) throw new TypeError('本地项目中的文件数据已损坏。');
  return new File([blob], record.name || blob.name || '未命名文件', {
    type: record.type || blob.type || '',
    lastModified: Number.isFinite(record.lastModified) ? record.lastModified : Date.now(),
  });
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('浏览器本地存储空间不足，项目未能自动保存。当前画面仍可继续使用。', { cause: error });
  return error || new Error('项目未能在本机保存。当前画面仍可继续使用。');
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持本地项目保存。当前画面仍可继续使用。'));
      return;
    }
    let request;
    try { request = indexedDB.open(DATABASE_NAME, 1); } catch (error) { reject(storageError(error)); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => reject(new Error('本地项目保存被另一个页面占用，请关闭旧页面后重试。'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      resolve(database);
    };
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

/** Merge supplied fields. Omitted/undefined fields are left untouched. */
export async function saveProjectFiles(patch) {
  const patchValidation = validateCachePatch(patch);
  const keys = Object.keys(patch).filter(key => patch[key] !== undefined);
  if (!keys.length) return;
  // Wrapping Files does not read or encode their contents.
  const records = Object.fromEntries(keys.map(key => [key, key === 'modelFiles' ? patch[key].map(wrapFile)
    : key === 'backgroundFile' || key === 'referenceFile' || key === 'supportFile' ? wrapFile(patch[key]) : patch[key]]));
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    let validationError;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(validationError || storageError(transaction.error));
    transaction.onabort = () => reject(validationError || storageError(transaction.error));
    const sizes = store.get(SIZE_KEY);
    sizes.onsuccess = () => {
      try {
        const mergedSourceBytes = { ...sizes.result };
        for (const key of keys) {
          if (SOURCE_KEYS.includes(key)) mergedSourceBytes[key] = patchValidation.sourceBytes[key];
        }
        // G-code can be large; its UTF-8 size was already measured above.
        const validated = validateCachePatch({}, mergedSourceBytes);
        for (const key of keys) store.put(records[key], key);
        if (keys.some(key => SOURCE_KEYS.includes(key))) store.put(validated.sourceBytes, SIZE_KEY);
      } catch (error) {
        validationError = error;
        transaction.abort();
      }
    };
  });
}

/** Restore sources from this origin; null means there is no saved project. */
export async function loadProjectFiles() {
  const database = await openDatabase();
  const records = await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const result = {};
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(storageError(transaction.error));
    transaction.onabort = () => reject(storageError(transaction.error));
    for (const key of PROJECT_KEYS) {
      const request = store.get(key);
      request.onsuccess = () => { if (request.result !== undefined) result[key] = request.result; };
    }
  });
  if (!Object.keys(records).length) return null;
  if (records.modelFiles) records.modelFiles = records.modelFiles.map(normalizeFile);
  for (const key of ['backgroundFile', 'referenceFile', 'supportFile']) {
    if (records[key] != null) records[key] = normalizeFile(records[key]);
  }
  return records;
}

export async function clearProjectFiles() {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(storageError(transaction.error));
    transaction.onabort = () => reject(storageError(transaction.error));
  });
}
