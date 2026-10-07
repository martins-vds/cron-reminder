export type NotificationRegistrationErrorCode =
  | "insecure-context"
  | "missing-vapid-key"
  | "push-service-unavailable"
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
