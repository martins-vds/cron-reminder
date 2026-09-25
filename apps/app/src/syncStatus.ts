import type { Locale } from "@cron-reminder/localization";

export interface ConnectivitySnapshot {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  browserOnline?: boolean;
}

export function synchronizationFailureMessage(
  locale: Locale,
  connectivity: ConnectivitySnapshot,
): string {
  const offline =
    connectivity.isConnected === false ||
    connectivity.isInternetReachable === false ||
    connectivity.browserOnline === false;
  if (offline) {
    return locale === "pt-BR"
      ? "Você está sem conexão. As alterações estão salvas neste dispositivo e serão sincronizadas quando a conexão voltar."
      : "You're offline. Changes are saved on this device and will sync when you reconnect.";
  }
  return locale === "pt-BR"
    ? "Não foi possível sincronizar as alterações. Elas estão salvas neste dispositivo. Tente novamente em instantes."
    : "We couldn't sync your changes. They're saved on this device. Try again in a moment.";
}
