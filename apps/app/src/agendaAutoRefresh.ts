export const agendaRefreshIntervalMs = 60_000;

export function startAgendaAutoRefresh(refresh: () => void): () => void {
  const interval = globalThis.setInterval(refresh, agendaRefreshIntervalMs);
  return () => globalThis.clearInterval(interval);
}
