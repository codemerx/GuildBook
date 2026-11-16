// How the switcher and the tray name a library (PLAN.md §3.1): its name and its prefix, e.g. "Acme (acme)". Two
// libraries of one owner have the same name, so the prefix tells them apart.
import type { InstanceView } from '@app/ipc';

export function libraryLabel(instance: Pick<InstanceView, 'name' | 'prefix'>): string {
  return instance.prefix ? `${instance.name} (${instance.prefix})` : instance.name;
}
