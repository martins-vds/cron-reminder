export type Locale = "en" | "pt-BR";

const messages = {
  en: {
    active: "Active",
    addReminder: "Add reminder",
    advanced: "Advanced cron",
    archive: "Archive",
    archived: "Archived",
    cancel: "Cancel",
    confirmDelete: "Delete this reminder permanently?",
    create: "Create",
    daily: "Daily",
    delete: "Delete",
    disabled: "Disabled",
    duplicate: "Duplicate",
    edit: "Edit",
    empty: "No reminders yet",
    enabled: "Enabled",
    history: "History",
    importBackup: "Import JSON",
    importBackupPrompt: "Paste JSON backup to merge",
    interval: "Interval",
    language: "Language",
    monthly: "Monthly",
    notes: "Notes",
    once: "Once",
    reminders: "Reminders",
    restore: "Restore",
    save: "Save",
    schedule: "Schedule",
    search: "Search reminders",
    settings: "Settings",
    signOut: "Sign out",
    signIn: "Sign in to continue",
    snooze: "Snooze",
    sound: "Sound",
    tags: "Tags",
    theme: "Theme",
    title: "Title",
    upcoming: "Next occurrences",
    enableNotifications: "Enable notifications on this device",
    enablingNotifications: "Enabling notifications...",
    notificationsEnabled: "Notifications are enabled on this device.",
    notificationPermissionDenied:
      "Notifications are blocked. Allow them for this site in your browser settings, then try again.",
    notificationUnsupported:
      "Web Push is not supported in this browser or installation.",
    notificationSecureContextRequired:
      "Notifications require a secure HTTPS connection.",
    notificationMissingConfiguration:
      "Web Push is not configured for this deployment.",
    notificationRegistrationFailed:
      "Notifications could not be enabled. Check your connection and try again.",
    deleteAccount: "Delete account and data",
    deleteAccountTitle: "Delete account",
    deleteAccountMessage: "This permanently deletes all synchronized data.",
    weekdays: "Weekdays",
    yearly: "Yearly",
  },
  "pt-BR": {
    active: "Ativo",
    addReminder: "Adicionar lembrete",
    advanced: "Cron avançado",
    archive: "Arquivar",
    archived: "Arquivados",
    cancel: "Cancelar",
    confirmDelete: "Excluir este lembrete permanentemente?",
    create: "Criar",
    daily: "Diariamente",
    delete: "Excluir",
    disabled: "Desativados",
    duplicate: "Duplicar",
    edit: "Editar",
    empty: "Nenhum lembrete",
    enabled: "Ativado",
    history: "Histórico",
    importBackup: "Importar JSON",
    importBackupPrompt: "Cole o backup JSON para mesclar",
    interval: "Intervalo",
    language: "Idioma",
    monthly: "Mensalmente",
    notes: "Notas",
    once: "Uma vez",
    reminders: "Lembretes",
    restore: "Restaurar",
    save: "Salvar",
    schedule: "Agenda",
    search: "Buscar lembretes",
    settings: "Configurações",
    signOut: "Sair",
    signIn: "Entre para continuar",
    snooze: "Adiar",
    sound: "Som",
    tags: "Etiquetas",
    theme: "Tema",
    title: "Título",
    upcoming: "Próximas ocorrências",
    enableNotifications: "Ativar notificações neste dispositivo",
    enablingNotifications: "Ativando notificações...",
    notificationsEnabled: "As notificações estão ativas neste dispositivo.",
    notificationPermissionDenied:
      "As notificações estão bloqueadas. Permita-as para este site nas configurações do navegador e tente novamente.",
    notificationUnsupported:
      "O Web Push não é compatível com este navegador ou instalação.",
    notificationSecureContextRequired:
      "As notificações exigem uma conexão HTTPS segura.",
    notificationMissingConfiguration:
      "O Web Push não está configurado para esta implantação.",
    notificationRegistrationFailed:
      "Não foi possível ativar as notificações. Verifique sua conexão e tente novamente.",
    deleteAccount: "Excluir conta e dados",
    deleteAccountTitle: "Excluir conta",
    deleteAccountMessage:
      "Isso exclui permanentemente todos os dados sincronizados.",
    weekdays: "Dias úteis",
    yearly: "Anualmente",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

export function normalizeLocale(locale: string | undefined): Locale {
  return locale?.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

export function createTranslator(locale: Locale): (key: MessageKey) => string {
  return (key) => messages[locale][key];
}
