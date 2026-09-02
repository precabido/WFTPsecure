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
 * availableBytes is DERIVED from usedPercent rather than passed separately.
 * Supplying both independently let a fixture claim "79.9% used, 20 GB free of
 * 100 GB" — which is 80% used, not 79.9%. The guard recomputes utilisation from
 * the byte figures when projecting a write forward, so it read 80% and refused,
 * and the test blamed the code for the fixture's contradiction. Real statfs
 * cannot return an inconsistent pair; the fixture should not either.
 */
function guardWithDisk(usedPercent: number, capBytes = 100 * GB): DiskGuard {
  const guard = new DiskGuard({
    storageRoot: tmpdir(),
    pressurePercent: 80,
    capBytes,
  });
  const totalBytes = 100 * GB;
  const availableBytes = Math.round(totalBytes * (1 - usedPercent / 100));
  Object.defineProperty(guard, 'status', {
    value: async () => ({ totalBytes, availableBytes, usedPercent }),
  });
  return guard;
}

describe('DiskGuard', () => {
  it('allows a write when the disk is comfortable', async () => {
    const guard = guardWithDisk(40);
    expect(await guard.check(1024, 0)).toBeNull();
  });

  it('refuses when the disk is already past the threshold', async () => {
    // The real scenario: a shared host at 97%. The old check would have said
    // yes, because our own accounting counter was near zero.
    const guard = guardWithDisk(97);
    expect(await guard.check(1024, 0)).toBe('disk-pressure');
  });

  it('refuses exactly at the threshold, not just above it', async () => {
    expect(await guardWithDisk(80).check(1, 0)).toBe('disk-pressure');
    expect(await guardWithDisk(79.9).check(1, 0)).toBeNull();
  });

  it('projects the write forward, so one large upload cannot cross the line', async () => {
    // 75% used, 25 GB free: comfortably under the threshold right now.
    const guard = guardWithDisk(75);
    expect(await guard.check(1 * GB, 0)).toBeNull();
    // But a 20 GB upload would land us at 95%. Checking only the current
    // reading would have waved this through.
    expect(await guard.check(20 * GB, 0)).toBe('disk-pressure');
  });

  it('still enforces the byte quota independently of disk space', async () => {
    // Plenty of disk, but this deployment has spent its budget.
    const guard = guardWithDisk(10, 1 * GB);
    expect(await guard.check(100, 900 * 1024 * 1024)).toBeNull();
    expect(await guard.check(200 * 1024 * 1024, 900 * 1024 * 1024)).toBe('quota');
  });

  it('fails closed when the filesystem cannot be read', async () => {
    // A vanished mount or a permission problem must refuse, not assume room.
    const guard = new DiskGuard({
      storageRoot: '/nonexistent-path-for-this-test',
      pressurePercent: 80,
      capBytes: 100 * GB,
    });
    expect(await guard.check(1024, 0)).toBe('disk-pressure');
  });

  it('reads a real directory end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cinderlink-disk-'));
    try {
      const guard = new DiskGuard({ storageRoot: dir, pressurePercent: 100, capBytes: 100 * GB });
      // pressurePercent 100 can never be reached, so a small write is allowed.
      expect(await guard.check(1024, 0)).toBeNull();

      // With a 1% threshold, any real disk is already over it.
      const strict = new DiskGuard({ storageRoot: dir, pressurePercent: 1, capBytes: 100 * GB });
      expect(await strict.check(1024, 0)).toBe('disk-pressure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
