/**
 * In-memory event bus for streaming optimization events to SSE connections.
 * Each job has its own EventEmitter instance.
 */

import { EventEmitter } from "events";
import type { OptimizationEvent } from "../types";

const busMap = new Map<string, EventEmitter>();

export function getJobBus(jobId: string): EventEmitter {
  if (!busMap.has(jobId)) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    busMap.set(jobId, emitter);
  }
  return busMap.get(jobId)!;
}

export function emitJobEvent(jobId: string, event: OptimizationEvent): void {
  const bus = getJobBus(jobId);
  bus.emit("event", event);
}

export function cleanupJobBus(jobId: string): void {
  const bus = busMap.get(jobId);
  if (bus) {
    bus.removeAllListeners();
    busMap.delete(jobId);
  }
}
