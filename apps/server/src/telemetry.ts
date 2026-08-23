import os from "node:os";
import { performance } from "node:perf_hooks";
import type { RuntimeTelemetry } from "@spikive/shared";

export interface CpuTickSnapshot {
  total: number;
  idle: number;
}

export function calculateHostCpuPercent(previous: CpuTickSnapshot, current: CpuTickSnapshot): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(idle)) return null;
  return clampPercent((1 - idle / total) * 100);
}

export function calculateProcessCpuPercent(
  usedMicroseconds: number,
  elapsedMilliseconds: number,
  logicalCores: number
): number | null {
  const capacityMicroseconds = elapsedMilliseconds * 1_000 * Math.max(1, logicalCores);
  if (!Number.isFinite(usedMicroseconds) || usedMicroseconds < 0 || !Number.isFinite(capacityMicroseconds) || capacityMicroseconds <= 0) return null;
  return clampPercent(usedMicroseconds / capacityMicroseconds * 100);
}

/**
 * Request-driven sampler: it owns no interval and therefore adds no background work
 * when the performance panel is not open in a browser.
 */
export class RuntimeTelemetrySampler {
  private hostCpu = readHostCpuTicks();
  private processCpu = process.cpuUsage();
  private sampledAt = performance.now();

  sample(): RuntimeTelemetry {
    const now = performance.now();
    const nextHostCpu = readHostCpuTicks();
    const nextProcessCpu = process.cpuUsage();
    const logicalCores = Math.max(1, os.cpus().length);
    const processDelta = {
      user: nextProcessCpu.user - this.processCpu.user,
      system: nextProcessCpu.system - this.processCpu.system
    };
    const memory = process.memoryUsage();
    const totalMemory = os.totalmem();
    const result: RuntimeTelemetry = {
      sampledAt: new Date().toISOString(),
      host: {
        cpuPercent: calculateHostCpuPercent(this.hostCpu, nextHostCpu),
        logicalCores,
        memoryUsedBytes: Math.max(0, totalMemory - os.freemem()),
        memoryTotalBytes: totalMemory
      },
      process: {
        cpuPercent: calculateProcessCpuPercent(processDelta.user + processDelta.system, now - this.sampledAt, logicalCores),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers
      }
    };
    this.hostCpu = nextHostCpu;
    this.processCpu = nextProcessCpu;
    this.sampledAt = now;
    return result;
  }
}

function readHostCpuTicks(): CpuTickSnapshot {
  let total = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { total, idle };
}

function clampPercent(value: number) {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
