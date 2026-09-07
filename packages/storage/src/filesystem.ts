/**
 * Private filesystem storage adapter.
 *
 * This is the default backend for the preview: MinIO would add ~400 MB of RSS
 * for no security benefit at this scale, and §7 explicitly permits a private
 * filesystem fallback. The root MUST live outside any directory the gateway
 * serves — enforced by convention (/srv/<slug>/data/object-storage) and by the
 * gateway config, which has no location block pointing at it.
 */

import { mkdir, readFile, writeFile, unlink, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { StorageAdapter } from './index.ts';
import { assertValidKey, StorageError } from './index.ts';

export class FilesystemStorage implements StorageAdapter {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /**
   * Map a key to an absolute path, then verify the result is still inside the
   * root. assertValidKey already rejects traversal, but this second check means
   * a future change to the key grammar cannot silently open an escape.
   */
  #pathFor(key: string): string {
    assertValidKey(key);
    const full = resolve(join(this.#root, key));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new StorageError('resolved path escapes the storage root', 'invalid-key');
    }
    return full;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write to a temp name and rename: a crash mid-write then leaves no
    // half-written chunk that would later fail authentication confusingly.
    const temp = `${path}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(temp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.#pathFor(key));
    } catch (error) {
      // Deleting something already gone is success, not failure — the worker
      // must be idempotent (§19).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const path = this.#pathFor(prefix);
    let count = 0;
    try {
      count = (await readdir(path)).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    await rm(path, { recursive: true, force: true });
    return count;
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.#pathFor(prefix);
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(join(dir, entry.name), childRel);
        else if (!entry.name.endsWith('.tmp')) out.push(`${prefix}/${childRel}`);
      }
    };
    await walk(base, '');
    return out;
  }

  async usedBytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else total += (await stat(full)).size;
      }
    };
    await walk(this.#root);
    return total;
  }

  /** Create the root with restrictive permissions. */
  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }
}
