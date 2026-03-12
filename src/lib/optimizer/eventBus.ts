/**
 * In-memory event bus for streaming optimization events to SSE connections.
 * Each job has its own EventEmitter instance.
 */

import { EventEmitter } from "events";
import type { OptimizationEvent } from "../types";

// Use Node.js global so the map is shared across all Next.js route bundles
// (each route is a separate webpack module scope, so module-level singletons are not shared)
declare global {
  // eslint-disable-next-line no-var
  var __optJobBus: Map<string, EventEmitter> | undefined;
  // eslint-disable-next-line no-var
  var __optJobBusTimers: Map<string, NodeJS.Timeout> | undefined;
}

const BUS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — auto-cleanup if orchestrator crashes

function getBusMap(): Map<string, EventEmitter> {
  if (!global.__optJobBus) {
    global.__optJobBus = new Map();
  }
  return global.__optJobBus;
}

function getTimerMap(): Map<string, NodeJS.Timeout> {
  if (!global.__optJobBusTimers) {
    global.__optJobBusTimers = new Map();
  }
  return global.__optJobBusTimers;
}

function scheduleCleanup(jobId: string): void {
  const timers = getTimerMap();
  const existing = timers.get(jobId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cleanupJobBus(jobId);
  }, BUS_TTL_MS);
  t.unref(); // don't block process exit
  timers.set(jobId, t);
}

export function getJobBus(jobId: string): EventEmitter {
  const busMap = getBusMap();
  if (!busMap.has(jobId)) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    busMap.set(jobId, emitter);
  }
  scheduleCleanup(jobId);
  return busMap.get(jobId)!;
}

export function emitJobEvent(jobId: string, event: OptimizationEvent): void {
  const bus = getJobBus(jobId);
  bus.emit("event", event);
}

export function cleanupJobBus(jobId: string): void {
  const busMap = getBusMap();
  const timers = getTimerMap();
  const bus = busMap.get(jobId);
  if (bus) {
    bus.removeAllListeners();
    busMap.delete(jobId);
  }
  const t = timers.get(jobId);
  if (t) {
    clearTimeout(t);
    timers.delete(jobId);
  }
}
