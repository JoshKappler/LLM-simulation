/**
 * Job registry — tracks active AbortControllers so the stop route can
 * immediately cancel in-flight Ollama requests instead of waiting for
 * the next stopFlag file check.
 */

const registry = new Map<string, AbortController>();

export function registerJob(jobId: string, controller: AbortController): void {
  registry.set(jobId, controller);
}

export function abortJob(jobId: string): void {
  const controller = registry.get(jobId);
  if (controller) {
    controller.abort();
    registry.delete(jobId);
  }
}

export function unregisterJob(jobId: string): void {
  registry.delete(jobId);
}
