/**
 * Lazy-loaded cache of disk identity info from smartctl.
 * Keyed by disk by-id name. Immutable per disk — model family,
 * form factor, firmware don't change unless the physical disk changes,
 * which means a new by-id key.
 */

import type { CommandExecutor } from '../executor/types.js'
import { isSmartctlStandby } from '../parsers/smartctl.js'

export interface DiskIdentity {
  /** Human-readable model family, e.g. "Western Digital Red Pro" */
  modelFamily: string | null
  /** Device model, e.g. "WDC WD2003FZEX-00SRLA0" */
  deviceModel: string | null
  /** Form factor, e.g. "2.5 inches", "3.5 inches", "M.2" */
  formFactor: string | null
  /** Firmware version */
  firmwareVersion: string | null
  /** Interface/protocol, e.g. "SATA 3.2, 6.0 Gb/s" */
  interface: string | null
  /** Whether TRIM is available (SSDs) */
  trimSupport: boolean
  /** SMART health: true=passed, false=failed, null=not supported/unknown */
  smartHealthy: boolean | null
  /**
   * The disk is asleep (STANDBY/SLEEP) and smartctl was told not to wake it —
   * nothing was measured this pass. Absent on a reading taken from an awake
   * disk.
   */
  standby?: boolean
  /**
   * The reported identity is the LAST KNOWN one, not a fresh reading: the disk
   * was asleep when read (`staleReason: 'standby'`) or the probe failed
   * (`staleReason: 'probe-failed'`). Only meaningful with a prior reading — a
   * never-seen standby disk carries `standby` without `stale` (there is no
   * prior reading to be stale relative to).
   */
  stale?: boolean
  /** Why the reading is stale — it was a standby skip, or the probe failed. */
  staleReason?: 'standby' | 'probe-failed'
}

export class DiskIdentityCache {
  /**
   * The last MEASURED identity per disk (an awake reading). A standby reading
   * never touches it — the disk may sleep for days under the spindown policy
   * and its measured identity stays the truth to report in the meantime. A
   * failed probe touches it only when the disk was never measured (the
   * unknown, cached so a never-answering disk is not re-probed every pass);
   * a disk WITH a measured identity reports that identity, stale, and is
   * re-probed on every pass until it answers again.
   */
  private measured = new Map<string, DiskIdentity>()
  /**
   * The latest reading to REPORT per disk: the measured identity, the measured
   * identity marked `standby` + `stale`, the last reading marked
   * `stale: 'probe-failed'` after a failed probe, or (a disk never seen awake)
   * placeholders marked `standby` with no health claim.
   */
  private reading = new Map<string, DiskIdentity>()
  private pending = new Map<string, Promise<DiskIdentity>>()
  private executor: CommandExecutor

  constructor(executor: CommandExecutor) {
    this.executor = executor
  }

  /** Get the latest reading (measured, or standby/failure-marked), or null if never loaded */
  getCached(diskId: string): DiskIdentity | null {
    return this.reading.get(diskId) ?? null
  }

  /**
   * Whether a disk's reading needs a fresh probe: it was never read, the last
   * reading was a standby skip (the disk may have woken), or the last probe
   * failed (smartctl may work again). A clean measured reading is a cache hit
   * — the identity does not change for the daemon's lifetime.
   */
  private isDue(reading: DiskIdentity | undefined): boolean {
    if (!reading)
      return true
    return !!reading.standby || reading.staleReason === 'probe-failed'
  }

  /**
   * Get the reading for a disk, re-reading smartctl when the reading is due
   * (standby skip or failed probe — the disk may have woken or recovered).
   */
  async get(diskId: string, devicePath: string): Promise<DiskIdentity> {
    const reading = this.reading.get(diskId)
    if (reading && !this.isDue(reading))
      return reading

    // Deduplicate concurrent requests for the same disk
    const existing = this.pending.get(diskId)
    if (existing)
      return existing

    const promise = this.load(diskId, devicePath)
    this.pending.set(diskId, promise)
    try {
      return await promise
    }
    finally {
      this.pending.delete(diskId)
    }
  }

  /**
   * Load readings for multiple disks in parallel. Disks whose reading is due
   * (standby skip or failed probe) are re-read; measured disks are left alone.
   *
   * The disk list is also the TOPOLOGY REFRESH: the cache is keyed per device,
   * and a device that has left the fleet must not leave its entries behind
   * (on a box where disks come and go, the maps would otherwise grow without
   * bound for the daemon's lifetime).
   */
  async loadMany(disks: Array<{ id: string, path: string }>): Promise<void> {
    const present = new Set(disks.map(d => d.id))
    for (const key of [...this.measured.keys()]) {
      if (!present.has(key))
        this.measured.delete(key)
    }
    for (const key of [...this.reading.keys()]) {
      if (!present.has(key))
        this.reading.delete(key)
    }

    const due = disks.filter(d => this.isDue(this.reading.get(d.id)))
    if (due.length === 0)
      return
    await Promise.all(due.map(d => this.get(d.id, d.path)))
  }

  private async load(diskId: string, devicePath: string): Promise<DiskIdentity> {
    const result = await this.fetchFromSmartctl(devicePath)
    if (result.kind === 'standby') {
      // The disk is asleep and we declined to wake it — nothing was measured.
      // Report the last measured identity marked standby+stale, or a
      // no-claim placeholder if the disk was never seen awake. The measured
      // map is untouched, and this reading is NOT a cache hit: the disk may
      // wake at any time, so the next pass retries.
      const last = this.measured.get(diskId)
      const identity = last
        ? { ...last, standby: true, stale: true, staleReason: 'standby' as const }
        : { ...emptyIdentity(), standby: true }
      this.reading.set(diskId, identity)
      return identity
    }
    if (result.kind === 'error') {
      // A probe ERROR is not a measurement. It must not overwrite the good
      // measured identity (one transient smartctl failure blanking
      // model/serial/health for the daemon's lifetime was the bug), and it
      // must not end the re-probes: the reading is not a cache hit, so the
      // next pass probes again. Report what the disk last had — the measured
      // identity, else its latest reading — marked stale.
      const prior = this.reading.get(diskId)
      if (prior) {
        const identity = {
          ...(this.measured.get(diskId) ?? prior),
          // The power mode is no longer known either — the probe did not get
          // to report it. Only the staleness stands.
          standby: false,
          stale: true,
          staleReason: 'probe-failed' as const,
        }
        this.reading.set(diskId, identity)
        return identity
      }
      // The FIRST probe of this disk failed: there is no reading to keep, so
      // there is nothing to blank. The empty identity, cached — a disk that
      // never answers must not be re-probed every pass (existing behaviour).
      const identity = emptyIdentity()
      this.measured.set(diskId, identity)
      this.reading.set(diskId, identity)
      return identity
    }
    this.measured.set(diskId, result.identity)
    this.reading.set(diskId, result.identity)
    return result.identity
  }

  private async fetchFromSmartctl(
    devicePath: string,
  ): Promise<{ kind: 'standby' } | { kind: 'error' } | { kind: 'measured', identity: DiskIdentity }> {
    try {
      // -n standby: if the disk is asleep, smartctl checks the power mode and
      // exits without issuing anything that would spin it up. -iH is identity +
      // health check (no full scan), fast.
      const result = await this.executor.exec('/usr/sbin/smartctl', ['-n', 'standby', '-iH', '--json', devicePath])
      if (isSmartctlStandby(result))
        return { kind: 'standby' }
      const data = JSON.parse(result.stdout)
      return {
        kind: 'measured',
        identity: {
          modelFamily: data.model_family ?? null,
          deviceModel: data.model_name ?? null,
          formFactor: data.form_factor?.name ?? null,
          firmwareVersion: data.firmware_version ?? null,
          interface: formatInterface(data),
          trimSupport: !!data.trim?.supported,
          smartHealthy: data.smart_status?.passed ?? null,
        },
      }
    }
    catch {
      // smartctl failed or returned invalid JSON. Report the error — NOT a
      // measured reading: an empty measured identity would overwrite a good
      // one and cache as a hit, so the disk was never probed again, even once
      // smartctl recovered. load() decides what the error means per disk.
      return { kind: 'error' }
    }
  }
}

function emptyIdentity(): DiskIdentity {
  return {
    modelFamily: null,
    deviceModel: null,
    formFactor: null,
    firmwareVersion: null,
    interface: null,
    trimSupport: false,
    smartHealthy: null,
  }
}

function formatInterface(data: any): string | null {
  if (data.sata_version?.string)
    return data.sata_version.string
  if (data.nvme_version?.string)
    return `NVMe ${data.nvme_version.string}`
  if (data.device?.protocol)
    return data.device.protocol
  return null
}
