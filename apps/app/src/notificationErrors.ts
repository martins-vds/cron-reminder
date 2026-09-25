export type NotificationRegistrationErrorCode =
  | "insecure-context"
  | "missing-vapid-key"
  | "subscription-failed"
  | "unsupported";

export class NotificationRegistrationError extends Error {
  constructor(
    readonly code: NotificationRegistrationErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "NotificationRegistrationError";
  }
}
