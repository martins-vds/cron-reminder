import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agendaRefreshIntervalMs,
  startAgendaAutoRefresh,
} from "./agendaAutoRefresh";

describe("agenda automatic refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes every minute until stopped", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const stop = startAgendaAutoRefresh(refresh);

    vi.advanceTimersByTime(agendaRefreshIntervalMs - 1);
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(agendaRefreshIntervalMs);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(agendaRefreshIntervalMs);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
