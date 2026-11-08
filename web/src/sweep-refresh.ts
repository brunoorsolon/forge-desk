import type { SweepStatus } from '../../src/core/scope.js';
import { errorMessage, fetchSweep, refreshAllSources } from './api.js';
import { ACTIVE_POLL_MS } from './polling.js';

export interface SweepRefreshState {
  sweep: SweepStatus | null;
  error: string | null;
}

/** Sweep status has its own visible-tab lane; it never polls unopened scopes. */
export function createSweepRefresh(
  changed: (state: SweepRefreshState) => void,
  settled: () => void,
  start: () => Promise<SweepStatus> = refreshAllSources,
  read: () => Promise<SweepStatus | null> = fetchSweep,
) {
  let sweep: SweepStatus | null = null;
  let launchError: string | null = null;
  let readError: string | null = null;
  let visible = true;
  let observed = false;
  let pending = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = () => sweep?.state === 'running' || sweep?.state === 'queued';
  const publish = () => changed({ sweep, error: launchError ?? readError });
  function cancelTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule(): void {
    cancelTimer();
    if (visible && running() && !pending) timer = setTimeout(() => void check(), ACTIVE_POLL_MS);
  }
  async function check(): Promise<void> {
    if (!visible || !observed || pending) return;
    cancelTimer();
    pending = true;
    const token = generation;
    try {
      const result = await read();
      if (token !== generation) return;
      const wasRunning = running();
      sweep = result;
      readError = null;
      publish();
      if (wasRunning && !running()) settled();
    } catch (error) {
      if (token === generation) {
        readError = errorMessage(error);
        publish();
      }
    } finally {
      if (token === generation) {
        pending = false;
        schedule();
      }
    }
  }
  return {
    async refresh(): Promise<void> {
      cancelTimer();
      const token = ++generation;
      pending = true;
      launchError = null;
      readError = null;
      publish();
      let succeeded = false;
      try {
        const result = await start();
        if (token !== generation) return;
        sweep = result;
        observed = true;
        succeeded = true;
        publish();
        if (!running()) settled();
      } catch (error) {
        if (token === generation) {
          launchError = errorMessage(error);
          publish();
        }
      } finally {
        if (token === generation) {
          pending = false;
          // Always read after a successful launch, even if a fast fixture finished.
          if (succeeded && visible) void check();
          else schedule();
        }
      }
    },
    setVisible(value: boolean): void {
      if (visible === value) return;
      visible = value;
      cancelTimer();
      if (visible && observed) void check();
    },
  };
}
