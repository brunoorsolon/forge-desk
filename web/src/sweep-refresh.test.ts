import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SweepStatus } from '../../src/core/scope.js';
import { createSweepRefresh, type SweepRefreshState } from './sweep-refresh.js';

const running: SweepStatus = {
  id: 'original',
  trigger: 'scheduled',
  state: 'running',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: null,
  sources: [
    {
      source: 'one',
      state: 'running',
      delayedUntil: null,
      error: null,
      policyConflict: null,
      projects: [
        {
          project: { source: 'one', repo: 'o/r' },
          state: 'checked',
          lastCheckedAt: '2026-01-01T00:00:01Z',
          error: null,
        },
      ],
    },
  ],
};
const complete: SweepStatus = {
  ...running,
  state: 'completed',
  finishedAt: '2026-01-01T00:00:02Z',
};
function setup(
  start = vi.fn(async () => running),
  read = vi.fn<() => Promise<SweepStatus | null>>().mockResolvedValue(running),
) {
  vi.useFakeTimers();
  const changed = vi.fn<(state: SweepRefreshState) => void>();
  const settled = vi.fn();
  return {
    controller: createSweepRefresh(changed, settled, start, read),
    start,
    read,
    changed,
    settled,
  };
}
afterEach(() => vi.useRealTimers());

describe('all-source refresh follow-up', () => {
  it.each(['queued', 'running'] as const)(
    'reads status after launch, follows a %s sweep every 60 seconds, and stops after completion',
    async (state) => {
      const { controller, read, changed, settled } = setup();
      read.mockResolvedValueOnce({ ...running, state }).mockResolvedValueOnce(complete);
      await controller.refresh();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenLastCalledWith({ launching: false, sweep: complete, error: null });
      expect(settled).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
  it('follows an interactive sweep every 2 seconds and re-reads the open scope on each poll', async () => {
    const interactive: SweepStatus = { ...running, trigger: 'interactive' };
    const { controller, read, settled } = setup(vi.fn(async () => interactive));
    read
      .mockResolvedValueOnce(interactive)
      .mockResolvedValueOnce(interactive)
      .mockResolvedValueOnce({ ...complete, trigger: 'interactive' });
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(settled).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('publishes a manual launch response immediately, before any polling timer advances', async () => {
    let finish!: (result: SweepStatus) => void;
    const { controller, changed, settled, read } = setup(
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      vi.fn(() => new Promise(() => {})),
    );
    const pending = controller.refresh();
    expect(changed).toHaveBeenLastCalledWith({ launching: true, sweep: null, error: null });
    finish(complete);
    await pending;
    expect(changed).toHaveBeenLastCalledWith({ launching: false, sweep: complete, error: null });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('joins retain the original start, trigger and project check times', async () => {
    const { controller, changed, start } = setup();
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(500);
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({ launching: false, sweep: running, error: null });
  });
  it('does not poll while hidden and checks once on return, including completion', async () => {
    const { controller, read, changed } = setup();
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(complete);
    controller.setVisible(true);
    controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({ launching: false, sweep: complete, error: null });
  });
  it('retains progress and the launch rejection even if a running sweep can still be read', async () => {
    const { controller, start, changed } = setup();
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    start.mockRejectedValueOnce(new Error('not allowed'));
    await controller.refresh();
    expect(changed).toHaveBeenLastCalledWith({
      launching: false,
      sweep: running,
      error: 'not allowed',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).toHaveBeenLastCalledWith({
      launching: false,
      sweep: running,
      error: 'not allowed',
    });
  });
  it('retains progress on a read failure and retries status, never the launch', async () => {
    const { controller, start, read, changed } = setup();
    read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(complete);
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith({
      launching: false,
      sweep: running,
      error: 'offline',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).toHaveBeenLastCalledWith({ launching: false, sweep: complete, error: null });
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('discards an older GET that finishes after a newer launch', async () => {
    let finish!: (r: SweepStatus) => void;
    const { controller, read, start, changed } = setup();
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await controller.refresh();
    const newer = { ...running, id: 'newer' };
    start.mockResolvedValueOnce(newer);
    read.mockResolvedValueOnce(newer);
    await controller.refresh();
    finish(complete);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith({ launching: false, sweep: newer, error: null });
  });
  it('does not begin polling if a launch finishes while hidden', async () => {
    let finish!: (r: SweepStatus) => void;
    const { controller, read } = setup(
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = controller.refresh();
    controller.setVisible(false);
    finish(running);
    await pending;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).not.toHaveBeenCalled();
    controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('sweep launch busy state', () => {
  it('clears launching after rejection and retries without treating a passive read as a launch', async () => {
    let reject!: (error: Error) => void;
    const { controller, changed, start, read } = setup(
      vi.fn(
        () =>
          new Promise((_resolve, no) => {
            reject = no;
          }),
      ),
    );
    const pending = controller.refresh();
    expect(changed).toHaveBeenLastCalledWith({ sweep: null, launching: true, error: null });
    reject(new Error('offline'));
    await pending;
    expect(changed).toHaveBeenLastCalledWith({ sweep: null, launching: false, error: 'offline' });
    expect(read).not.toHaveBeenCalled();
    start.mockResolvedValueOnce(complete);
    read.mockImplementationOnce(() => new Promise(() => {}));
    await controller.refresh();
    expect(changed).toHaveBeenLastCalledWith({ sweep: complete, launching: false, error: null });
  });

  it('keeps a newer launch busy when the older launch settles', async () => {
    let finishOld!: (sweep: SweepStatus) => void;
    let finishNew!: (sweep: SweepStatus) => void;
    const { controller, changed } = setup(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishNew = resolve;
            }),
        ),
    );
    const old = controller.refresh();
    const current = controller.refresh();
    finishOld(complete);
    await old;
    expect(changed).toHaveBeenLastCalledWith({ sweep: null, launching: true, error: null });
    finishNew(running);
    await current;
    expect(changed).toHaveBeenLastCalledWith({ sweep: running, launching: false, error: null });
  });
});
