// Invite links reaching the app (PLAN.md §3.17 step 1, IMPLEMENTATION.md Step 15): as a launch argument (Windows,
// Linux), through the second-instance event when the app runs already, or through macOS's open-url event. Each link
// is checked before anything runs (PLAN.md §3.15). The window shows "Join Acme" for a valid one; the renderer takes
// the invite once its page shows it, so a window opened later still finds it.
import { isAppLink, type Logger, parseInviteLink } from '@app/core';
import type { InviteView } from '@app/ipc';

/** The app's link among the launch arguments, if one is there. */
export function linkInArgs(args: readonly string[]): string | null {
  return args.find((arg) => isAppLink(arg)) ?? null;
}

export class InviteInbox {
  readonly #logger: Logger;
  readonly #onInvite: (invite: InviteView) => void;
  #seq = 0;
  #pending: InviteView | null = null;

  constructor(deps: { logger: Logger; onInvite: (invite: InviteView) => void }) {
    this.#logger = deps.logger;
    this.#onInvite = deps.onInvite;
  }

  /** A link from the OS. A link that isn't valid is refused, and the window says so. */
  receive(raw: string): InviteView {
    const checked = parseInviteLink(raw.trim());
    const seq = ++this.#seq;
    const invite: InviteView = checked.ok
      ? { ok: true, url: checked.invite.url, clientId: checked.invite.clientId, seq }
      : { ok: false, problem: checked.problem, seq };
    if (checked.ok) this.#logger.info('invite link opened', { url: checked.invite.url });
    else this.#logger.warn('an invite link was refused', { problem: checked.problem });
    this.#pending = invite;
    this.#onInvite(invite);
    return invite;
  }

  pending(): InviteView | null {
    return this.#pending;
  }

  /** The window showed it. */
  take(seq: number): void {
    if (this.#pending?.seq === seq) this.#pending = null;
  }
}
