import type { StorageAdapter } from './index.ts';
import { FilesystemStorage } from './filesystem.ts';

/**
 * Select a storage backend.
 *
 * Filesystem is the default for the preview deployment. The interface exists so
 * an S3/MinIO adapter can be dropped in without touching call sites; that
 * adapter is deliberately not written yet, because shipping an untested second
 * backend would be worse than shipping one that is exercised by every test.
 */
export async function createStorage(env: NodeJS.ProcessEnv = process.env): Promise<StorageAdapter> {
  const driver = env.STORAGE_DRIVER ?? 'filesystem';
  switch (driver) {
    case 'filesystem': {
      const root = env.STORAGE_ROOT;
      if (!root) throw new Error('STORAGE_ROOT is required when STORAGE_DRIVER=filesystem');
      const storage = new FilesystemStorage(root);
      await storage.init();
      return storage;
    }
    default:
      throw new Error(`unknown STORAGE_DRIVER: ${driver}`);
  }
}
