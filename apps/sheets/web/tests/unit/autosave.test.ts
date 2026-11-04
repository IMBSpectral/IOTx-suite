import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Debounced } from "../../src/store/autosave";

describe("Debounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of edits into one save", async () => {
    const task = vi.fn(async () => {});
    const d = new Debounced(task, 500);
    d.schedule();
    d.schedule();
    await vi.advanceTimersByTimeAsync(400);
    d.schedule();
    await vi.advanceTimersByTimeAsync(499);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("never overlaps saves, and saves again for edits made during a save", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          release = () => {
            active--;
            resolve();
          };
        }),
    );
    const d = new Debounced(task, 10);
    d.schedule();
    await vi.advanceTimersByTimeAsync(10);
    d.schedule(); // an edit while the first save is still writing
    await vi.advanceTimersByTimeAsync(10);
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxActive).toBe(1);
  });

  it("flush runs a pending save immediately", async () => {
    const task = vi.fn(async () => {});
    const d = new Debounced(task, 10_000);
    d.schedule();
    await d.flush();
    expect(task).toHaveBeenCalledTimes(1);
  });
});
