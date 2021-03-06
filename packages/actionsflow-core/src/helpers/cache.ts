import manager, {
  Store,
  StoreConfig,
  CachingConfig,
  MultiCache,
} from "cache-manager";
import fs from "fs-extra";
import fsStore from "cache-manager-fs-hash";
import path from "path";
import { CACHE_PATH } from "../constans";
const MAX_CACHE_SIZE = 250;
const TTL = Number.MAX_SAFE_INTEGER;

interface ICacheProperties {
  name?: string;
  store?: Store;
}

export class Cache {
  public name: string;
  public store: Store;
  public cache?: MultiCache;

  constructor({ name = `db`, store = fsStore }: ICacheProperties = {}) {
    this.name = name;
    this.store = store;
  }

  get directory(): string {
    return path.join(process.cwd(), CACHE_PATH, `caches/${this.name}`);
  }

  init(): Cache {
    fs.ensureDirSync(this.directory);

    const configs: StoreConfig[] = [
      {
        store: `memory`,
        max: MAX_CACHE_SIZE,
        ttl: TTL,
      },
      {
        store: this.store,
        ttl: TTL,
        options: {
          path: this.directory,
          ttl: TTL,
        },
      },
    ];

    const caches = configs.map((cache) => manager.caching(cache));

    this.cache = manager.multiCaching(caches);

    return this;
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      if (!this.cache) {
        throw new Error(
          `Cache wasn't initialised yet, please run the init method first`
        );
      }
      this.cache.get<T>(key, (err, res) => {
        resolve(err ? undefined : res);
      });
    });
  }

  set<T>(
    key: string,
    value: T,
    args: CachingConfig = { ttl: TTL }
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      if (!this.cache) {
        throw new Error(
          `Cache wasn't initialised yet, please run the init method first`
        );
      }
      this.cache.set(key, value, args, (err) => {
        resolve(err ? undefined : value);
      });
    });
  }
  del<T = unknown>(key: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      if (!this.cache) {
        throw new Error(
          `Cache wasn't initialised yet, please run the init method first`
        );
      }
      this.cache.del(key, (err) => {
        resolve(err ? undefined : undefined);
      });
    });
  }

  reset<T = unknown>(): Promise<T | undefined> {
    return new Promise((resolve) => {
      if (!this.cache) {
        throw new Error(
          `Cache wasn't initialised yet, please run the init method first`
        );
      }
      this.cache.reset(() => {
        // delete directory
        fs.remove(this.directory)
          .then(() => {
            resolve(undefined);
          })
          .catch(() => {
            resolve(undefined);
          });
      });
    });
  }
}

const caches = new Map<string, Cache>();

export const getCache = (name: string): Cache => {
  let cache = caches.get(name);
  if (!cache) {
    cache = new Cache({ name }).init();
    caches.set(name, cache);
  }
  return cache;
};

export const removeCache = async (name: string): Promise<void> => {
  const cache = caches.get(name);
  if (!cache) {
    return;
  } else {
    await cache.reset();
    caches.delete(name);
    return;
  }
};
