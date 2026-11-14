import { parseProject } from "./catalog";
import { validateComponentDefinition } from "./componentRegistry";
import type { ComponentDefinition, Project } from "./types";

const DATABASE = "mechanical-studio-v1";
const STORE = "workspace";
const PROJECT_KEY = "current-project";
const LIBRARY_KEY = "user-components";
const LEGACY_PROJECT_KEY = "mechanical-studio-project-v1";
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_SERIALIZED_CHARACTERS = 96 * 1024 * 1024;
const MIRROR_CHARACTERS = 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
let pendingWrites: Promise<void> = Promise.resolve();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("当前环境无法使用本地数据库，请导出工程保存。"),
    );
  }
  database = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error("无法打开本地数据库。"));
    };
    request.onblocked = () => {
      settled = true;
      reject(
        new Error("本地数据库正被旧窗口占用，请关闭其他工作台窗口后重试。"),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function readValue(key: string): Promise<unknown> {
  await pendingWrites;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(key);
    let result: unknown;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("读取事务已中断。"));
    transaction.onerror = () =>
      reject(
        transaction.error ?? request.error ?? new Error("读取本地数据失败。"),
      );
  });
}

async function writeValue(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const request = transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? request.error ?? new Error("保存事务已中断。"),
      );
    transaction.onerror = () =>
      reject(
        transaction.error ??
          request.error ??
          new Error("本地存储空间不足或不可写。"),
      );
  });
}

function enqueue(write: () => Promise<void>): Promise<void> {
  const result = pendingWrites.then(write);
  // A failed write is reported to its caller, but must not poison later saves.
  pendingWrites = result.catch(() => {});
  return result;
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length > MAX_SERIALIZED_CHARACTERS) {
    throw new Error(
      "工程或组件库过大，请减少模型后保存（模型总量上限 64 MiB）。",
    );
  }
  return text;
}

function readLegacyProject(): Project | null {
  const text = localStorage.getItem(LEGACY_PROJECT_KEY);
  return text === null ? null : parseProject(text);
}

/** IndexedDB always wins over the compatibility mirror. Corrupt data is never deleted. */
export async function loadSavedProject(): Promise<Project | null> {
  try {
    const stored = await readValue(PROJECT_KEY);
    if (stored !== undefined) {
      if (typeof stored !== "string") throw new Error("本地工程记录格式无效。");
      return parseProject(stored);
    }
    // The old client stored only JSON here. Its first successful save migrates it.
    return readLegacyProject();
  } catch (error) {
    throw new Error(`无法恢复本地工程，原数据已保留：${message(error)}`);
  }
}

/** Persist complete model bytes. The localStorage copy is optional and never authoritative. */
export function saveProject(project: Project): Promise<void> {
  let serialized: string;
  try {
    const total = (project.models ?? []).reduce(
      (sum, model) => sum + model.bytes,
      0,
    );
    if (!Number.isFinite(total) || total > MAX_MODEL_BYTES) {
      throw new Error("工程模型总量不能超过 64 MiB。");
    }
    serialized = serialize(project);
  } catch (error) {
    return Promise.reject(new Error(`工程未保存：${message(error)}`));
  }
  return enqueue(async () => {
    try {
      await writeValue(PROJECT_KEY, serialized);
    } catch (error) {
      throw new Error(`工程未保存，请导出备份：${message(error)}`);
    }
    try {
      if (serialized.length <= MIRROR_CHARACTERS)
        localStorage.setItem(LEGACY_PROJECT_KEY, serialized);
      else localStorage.removeItem(LEGACY_PROJECT_KEY);
    } catch {
      // A mirror quota failure does not invalidate an already committed database write.
    }
  });
}

function validateLibrary(raw: unknown): ComponentDefinition[] {
  if (!Array.isArray(raw) || raw.length > 500)
    throw new Error("组件库格式无效，最多保存 500 个组件。");
  const ids = new Set<string>();
  let bytes = 0;
  return raw.map((entry) => {
    const component = validateComponentDefinition(entry);
    if (ids.has(component.id)) throw new Error("组件库存在重复标识。");
    ids.add(component.id);
    bytes += component.model.bytes;
    if (bytes > MAX_MODEL_BYTES)
      throw new Error("组件库模型总量不能超过 64 MiB。");
    return component;
  });
}

export async function loadUserComponents(): Promise<ComponentDefinition[]> {
  try {
    const stored = await readValue(LIBRARY_KEY);
    if (stored === undefined) return [];
    if (typeof stored !== "string") throw new Error("本地组件库记录格式无效。");
    return validateLibrary(JSON.parse(stored));
  } catch (error) {
    throw new Error(`无法恢复自定义组件库，原数据已保留：${message(error)}`);
  }
}

export function saveUserComponents(list: ComponentDefinition[]): Promise<void> {
  let serialized: string;
  try {
    serialized = serialize(validateLibrary(list));
  } catch (error) {
    return Promise.reject(new Error(`组件库未保存：${message(error)}`));
  }
  return enqueue(async () => {
    try {
      await writeValue(LIBRARY_KEY, serialized);
    } catch (error) {
      throw new Error(`组件库未保存，请导出备份：${message(error)}`);
    }
  });
}
