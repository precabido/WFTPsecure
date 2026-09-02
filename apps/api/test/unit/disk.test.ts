/**
 * Disk pressure guard (§18).
 *
 * These tests exist because the previous implementation looked correct and was
 * not: it compared an internal counter against a configured cap and never
 * touched the filesystem, so on a host that was already 97% full it would have
 * accepted uploads until the last free byte was gone.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskGuard, readDiskStatus } from '../../src/disk.ts';

const GB = 1024 * 1024 * 1024;

describe('readDiskStatus', () => {
  it('reports plausible figures for a real path', async () => {
    const status = await readDiskStatus(tmpdir());
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.availableBytes).toBeGreaterThanOrEqual(0);
    expect(status.availableBytes).toBeLessThanOrEqual(status.totalBytes);
    expect(status.usedPercent).toBeGreaterThanOrEqual(0);
    expect(status.usedPercent).toBeLessThanOrEqual(100);
  });
});

/**
 * A guard whose filesystem view is fixed, so thresholds can be tested exactly.
 *
 * Takes an options object rather than positional arguments: once a third and
 * fourth knob appeared, positional calls silently used defaults the test's own
 * comment claimed to have changed — one case asserted "with the percentage
 * relaxed" while leaving it at 80.
 *
 * availableBytes is DERIVED from usedPercent unless given explicitly. Supplying
 * both independently let a fixture claim "79.9% used, 20 GB free of 100 GB" —
 * which is 80% used. The guard recomputes utilisation from the byte figures
 * when projecting a write forward, so it read 80% and refused, and the test
 * blamed the code for the fixture's contradiction. Real statfs cannot return an
 * inconsistent pair; the fixture should not either.
 */
function guardWithDisk(options: {
  usedPercent: number;
  pressurePercent?: number;
  minFreeBytes?: number;
  capBytes?: number;
  totalBytes?: number;
  availableBytes?: number;
}): DiskGuard {
  const totalBytes = options.totalBytes ?? 100 * GB;
  const availableBytes =
    options.availableBytes ?? Math.round(totalBytes * (1 - options.usedPercent / 100));
  const guard = new DiskGuard({
    storageRoot: tmpdir(),
    pressurePercent: options.pressurePercent ?? 80,
    minFreeBytes: options.minFreeBytes ?? 0,
    capBytes: options.capBytes ?? 100 * GB,
  });
  Object.defineProperty(guard, 'status', {
    value: async () => ({ totalBytes, availableBytes, usedPercent: options.usedPercent }),
    configurable: true,
  });
  return guard;
}

describe('DiskGuard', () => {
  it('allows a write when the disk is comfortable', async () => {
    const guard = guardWithDisk({ usedPercent: 40 });
    expect(await guard.check(1024, 0)).toBeNull();
  });

  it('refuses when the disk is already past the threshold', async () => {
    // The real scenario: a shared host at 97%. The old check would have said
    // yes, because our own accounting counter was near zero.
    const guard = guardWithDisk({ usedPercent: 97 });
    expect(await guard.check(1024, 0)).toBe('disk-pressure');
  });

  it('refuses exactly at the threshold, not just above it', async () => {
    expect(await guardWithDisk({ usedPercent: 80 }).check(1, 0)).toBe('disk-pressure');
    expect(await guardWithDisk({ usedPercent: 79.9 }).check(1, 0)).toBeNull();
  });

  it('projects the write forward, so one large upload cannot cross the line', async () => {
    // 75% used, 25 GB free: comfortably under the threshold right now.
    const guard = guardWithDisk({ usedPercent: 75 });
    expect(await guard.check(1 * GB, 0)).toBeNull();
    // But a 20 GB upload would land us at 95%. Checking only the current
    // reading would have waved this through.
    expect(await guard.check(20 * GB, 0)).toBe('disk-pressure');
  });

  it('still enforces the byte quota independently of disk space', async () => {
    // Plenty of disk, but this deployment has spent its budget.
    const guard = guardWithDisk({ usedPercent: 10, capBytes: 1 * GB });
    expect(await guard.check(100, 900 * 1024 * 1024)).toBeNull();
    expect(await guard.check(200 * 1024 * 1024, 900 * 1024 * 1024)).toBe('quota');
  });

  it('enforces an absolute free-space floor independently of the percentage', async () => {
    // The shared-host case: 86% used sounds alarming, but on a 100 GB volume
    // that is 14 GB free — no danger at all for a service that stores tens of
    // megabytes. With the percentage relaxed, the floor is what protects the
    // host, and it does so in the units that actually matter.
    // pressurePercent raised to 99 — the shared-host configuration.
    const guard = guardWithDisk({ usedPercent: 86, pressurePercent: 99, minFreeBytes: 5 * GB });
    expect(await guard.check(1 * GB, 0)).toBeNull();

    // A write that would eat into the reserve is refused even though the
    // percentage rule is satisfied.
    expect(await guard.check(10 * GB, 0)).toBe('disk-pressure');
  });

  it('lets the floor refuse where the percentage would have allowed', async () => {
    // 50% of a tiny disk: percentage is happy, but only 2 GB remain and the
    // operator reserved 5 GB.
    const guard = guardWithDisk({
      usedPercent: 50,
      minFreeBytes: 5 * GB,
      totalBytes: 4 * GB,
      availableBytes: 2 * GB,
    });
    expect(await guard.check(1, 0)).toBe('disk-pressure');
  });

  it('fails closed when the filesystem cannot be read', async () => {
    // A vanished mount or a permission problem must refuse, not assume room.
    const guard = new DiskGuard({
      storageRoot: '/nonexistent-path-for-this-test',
      pressurePercent: 80,
      minFreeBytes: 0,
      capBytes: 100 * GB,
    });
    expect(await guard.check(1024, 0)).toBe('disk-pressure');
  });

  it('reads a real directory end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cinderlink-disk-'));
    try {
      const guard = new DiskGuard({ storageRoot: dir, pressurePercent: 100, minFreeBytes: 0, capBytes: 100 * GB });
      // pressurePercent 100 can never be reached, so a small write is allowed.
      expect(await guard.check(1024, 0)).toBeNull();

      // With a 1% threshold, any real disk is already over it.
      const strict = new DiskGuard({ storageRoot: dir, pressurePercent: 1, minFreeBytes: 0, capBytes: 100 * GB });
      expect(await strict.check(1024, 0)).toBe('disk-pressure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
