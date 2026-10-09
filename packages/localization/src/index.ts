export type Locale = "en" | "pt-BR";

const messages = {
  en: {
    active: "Active",
    addReminder: "Add reminder",
    advanced: "Advanced cron",
    agenda: "Today",
    analytics: "Analytics",
    category: "Category",
    categories: "Categories",
    allCategories: "All",
    uncategorized: "Uncategorized",
    manageCategories: "Manage categories",
    categoryName: "Category name",
    categoryNameRequired: "Enter a category name.",
    categoryNameReserved: "This name is reserved. Choose another name.",
    categoryNameDuplicate:
      "A category already uses this name. Choose another name.",
    categoryNotFound: "This category was removed. Choose another category.",
    categoryConcurrentEdit:
      "This category changed on another device. Refresh and resolve the edit.",
    categoryConnectionRequired: "Reconnect to resolve this category edit.",
    categoryFailed: "Could not change categories. Try again.",
    categoryPending:
      "Changes are saved on this device and waiting to sync. Reconnect and retry.",
    categoryConflict:
      "This category was edited on another device. Choose which name to keep.",
    analyticsConnectionRequired: "Reconnect to load analytics.",
    archive: "Archive",
    archived: "Archived",
    cancel: "Cancel",
    complete: "Complete",
    completeReminder: "Complete reminder",
    completed: "Completed",
    confirmDelete: "Delete this reminder permanently?",
    create: "Create",
    daily: "Daily",
    delete: "Delete",
    disabled: "Disabled",
    dismiss: "Dismiss",
    duplicate: "Duplicate",
    edit: "Edit",
    empty: "No reminders yet",
    enabled: "Enabled",
    history: "History",
    importBackup: "Import JSON",
    importBackupPrompt: "Choose JSON backup file",
    interval: "Interval",
    language: "Language",
    monthly: "Monthly",
    multipleDaily: "Multiple times daily",
    notes: "Notes",
    once: "Once",
    reminders: "Reminders",
    refresh: "Refresh",
    restore: "Restore",
    reopen: "Reopen",
    save: "Save",
    schedule: "Schedule",
    search: "Search reminders",
    settings: "Settings",
    signOut: "Sign out",
    signIn: "Sign in to continue",
    snooze: "Postpone",
    sound: "Sound",
    tags: "Tags",
    theme: "Theme",
    title: "Title",
    upcoming: "Next occurrences",
    enableNotifications: "Enable notifications on this device",
    enablingNotifications: "Enabling notifications...",
    disableNotifications: "Disable notifications on this device",
    disablingNotifications: "Disabling notifications...",
    notificationsDisabled:
      "Notifications are disabled on this device. Other devices are unaffected.",
    notificationDisableFailed:
      "Notifications could not be disabled. Check your connection and try again.",
    notificationsEnabled: "Notifications are enabled on this device.",
    notificationPermissionDenied:
      "Notifications are blocked. Allow them for this site in your browser settings, then try again.",
    notificationUnsupported:
      "Web Push is not supported in this browser or installation.",
    notificationSecureContextRequired:
      "Notifications require a secure HTTPS connection.",
    notificationMissingConfiguration:
      "Web Push is not configured for this deployment.",
    notificationPushServiceUnavailable:
      "Your browser could not register with its notification service. Restart or update the browser, check VPN or firewall restrictions, and try again.",
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
    agenda: "Hoje",
    analytics: "Análises",
    category: "Categoria",
    categories: "Categorias",
    allCategories: "Todos",
    uncategorized: "Sem categoria",
    manageCategories: "Gerenciar categorias",
    categoryName: "Nome da categoria",
    categoryNameRequired: "Digite um nome para a categoria.",
    categoryNameReserved: "Este nome é reservado. Escolha outro nome.",
    categoryNameDuplicate:
      "Uma categoria já usa este nome. Escolha outro nome.",
    categoryNotFound: "Esta categoria foi removida. Escolha outra categoria.",
    categoryConcurrentEdit:
      "Esta categoria mudou em outro dispositivo. Atualize e resolva a edição.",
    categoryConnectionRequired:
      "Reconecte para resolver esta edição de categoria.",
    categoryFailed: "Não foi possível alterar as categorias. Tente novamente.",
    categoryPending:
      "As alterações foram salvas neste dispositivo e aguardam sincronização. Reconecte e tente novamente.",
    categoryConflict:
      "Esta categoria foi editada em outro dispositivo. Escolha qual nome manter.",
    analyticsConnectionRequired: "Reconecte para carregar as análises.",
    archive: "Arquivar",
    archived: "Arquivados",
    cancel: "Cancelar",
    complete: "Concluir",
    completeReminder: "Concluir lembrete",
    completed: "Concluídos",
    confirmDelete: "Excluir este lembrete permanentemente?",
    create: "Criar",
    daily: "Diariamente",
    delete: "Excluir",
    disabled: "Desativados",
    dismiss: "Dispensar",
    duplicate: "Duplicar",
    edit: "Editar",
    empty: "Nenhum lembrete",
    enabled: "Ativado",
    history: "Histórico",
    importBackup: "Importar JSON",
    importBackupPrompt: "Selecionar arquivo de backup JSON",
    interval: "Intervalo",
    language: "Idioma",
    monthly: "Mensalmente",
    multipleDaily: "Vários horários por dia",
    notes: "Notas",
    once: "Uma vez",
    reminders: "Lembretes",
    refresh: "Atualizar",
    restore: "Restaurar",
    reopen: "Reabrir",
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
    disableNotifications: "Desativar notificações neste dispositivo",
    disablingNotifications: "Desativando notificações...",
    notificationsDisabled:
      "As notificações estão desativadas neste dispositivo. Os outros dispositivos não foram afetados.",
    notificationDisableFailed:
      "Não foi possível desativar as notificações. Verifique sua conexão e tente novamente.",
    notificationsEnabled: "As notificações estão ativas neste dispositivo.",
    notificationPermissionDenied:
      "As notificações estão bloqueadas. Permita-as para este site nas configurações do navegador e tente novamente.",
    notificationUnsupported:
      "O Web Push não é compatível com este navegador ou instalação.",
    notificationSecureContextRequired:
      "As notificações exigem uma conexão HTTPS segura.",
    notificationMissingConfiguration:
      "O Web Push não está configurado para esta implantação.",
    notificationPushServiceUnavailable:
      "O navegador não conseguiu se registrar no serviço de notificações. Reinicie ou atualize o navegador, verifique as restrições de VPN ou firewall e tente novamente.",
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
