// System notifications (PLAN.md §3.19). Main shows them, unless the user switched their type off or turned on Do not
// disturb; workers ask main through the device services.
import type { NotificationType } from '@app/schemas';

export type NotificationKind = NotificationType;

export interface Notification {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}
