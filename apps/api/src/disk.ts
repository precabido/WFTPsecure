/**
 * Real filesystem pressure check (§18).
 *
 * §18 asks us to "reject new uploads when the disk exceeds a safe threshold,
 * for example 80%". That is a statement about the DISK, not about a configured
 * byte budget — and the two are not interchangeable on a shared host.
 *
 * The original implementation only compared an internal accounting counter
 * against STORAGE_CAP_BYTES. On a machine whose disk was already 97% full with
 * other people's data, that check would have happily accepted uploads until the
 * last free byte was gone, taking every other service on the box down with it.
 * A byte cap answers "have we stored too much?"; it cannot answer "is there
 * room?".
 *
 * So we now check both, and the stricter one wins:
 *   1. actual filesystem utilisation at the storage root, and
 *   2. the configured cap on our own stored bytes.
 */

import { statfs } from 'node:fs/promises';

export interface DiskStatus {
  totalBytes: number;
  availableBytes: number;
  /** 0..100, based on space unavailable to an unprivileged writer. */
  usedPercent: number;
}

/**
 * Read filesystem statistics for the path.
 *
 * `bavail` (blocks free to an unprivileged user) is used rather than `bfree`,
 * because ext4 reserves a percentage for root that we must not count as usable.
 */
export async function readDiskStatus(path: string): Promise<DiskStatus> {
  const stats = await statfs(path);
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  const usedPercent = totalBytes === 0 ? 100 : ((totalBytes - availableBytes) / totalBytes) * 100;
  return { totalBytes, availableBytes, usedPercent };
}

export interface DiskGuardOptions {
  storageRoot: string;
  /** Refuse writes at or above this filesystem utilisation. */
  pressurePercent: number;
  /** Independent ceiling on bytes this deployment may store. */
  capBytes: number;
  /** How long to reuse a statfs result, in ms. */
  cacheMs?: number;
}

export type DiskRefusal = 'disk-pressure' | 'quota' | null;

/**
 * Guard that answers "may we accept `additionalBytes` right now?".
 *
 * statfs is a syscall, and every upload would otherwise perform one. The result
 * is cached briefly: disk usage does not move meaningfully in a second, and a
 * stale reading is bounded by the same threshold that made it safe.
 */
export class DiskGuard {
  readonly #options: Required<DiskGuardOptions>;
  #cached: { at: number; status: DiskStatus } | null = null;

  constructor(options: DiskGuardOptions) {
    this.#options = { cacheMs: 5000, ...options };
  }

  async status(): Promise<DiskStatus> {
    const now = Date.now();
    if (this.#cached !== null && now - this.#cached.at < this.#options.cacheMs) {
      return this.#cached.status;
    }
    const status = await readDiskStatus(this.#options.storageRoot);
    this.#cached = { at: now, status };
    return status;
  }

  /**
   * Returns null when the write may proceed, or the reason it may not.
   *
   * Fails CLOSED: if statfs throws (a permission problem, a vanished mount) we
   * refuse rather than assume there is room. Guessing optimistically is how a
   * disk-full outage happens.
   */
  async check(additionalBytes: number, storedBytes: number): Promise<DiskRefusal> {
    if (storedBytes + additionalBytes > this.#options.capBytes) return 'quota';

    let status: DiskStatus;
    try {
      status = await this.status();
    } catch {
      return 'disk-pressure';
    }

    if (status.usedPercent >= this.#options.pressurePercent) return 'disk-pressure';

    // Also project forward: a single large upload must not push us past the
    // threshold, even if we are under it at this instant.
    const projectedAvailable = status.availableBytes - additionalBytes;
    const projectedUsedPercent =
      status.totalBytes === 0 ? 100 : ((status.totalBytes - projectedAvailable) / status.totalBytes) * 100;
    if (projectedUsedPercent >= this.#options.pressurePercent) return 'disk-pressure';

    return null;
  }
}
