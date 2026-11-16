// Invite links (PLAN.md §3.17 Admin step 8): `<scheme>://join?url=<git URL>`, plus the public client id of the app
// registered on a self-hosted server. A link holds no password or token. A link that comes from the OS is untrusted
// input, so it's checked like a pasted URL (PLAN.md §3.15) before anything runs.
import { brand } from '@app/brand';
import { parseGitUrl } from '../../library/index.ts';

/** Longer links are refused before they're read. */
export const INVITE_LINK_MAX = 4096;

/** A public client id: what GitHub and GitLab issue (letters, digits, dots, dashes, underscores). */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,200}$/;

export interface Invite {
  /** The git URL, as the link has it. */
  readonly url: string;
  readonly clientId: string | null;
}

export type InviteProblem =
  /** Not this app's scheme, or not a link at all. */
  | 'notInvite'
  /** This app's scheme, but not a join link. */
  | 'action'
  /** No git URL, or one that isn't valid. */
  | 'url'
  | 'clientId'
  /** Something the app doesn't know: a newer app's link, or a link someone changed. */
  | 'unknownPart'
  | 'tooLong';

export type InviteCheck =
  { readonly ok: true; readonly invite: Invite } | { readonly ok: false; readonly problem: InviteProblem };

/** The invite link for a library's git URL. */
export function inviteLink(invite: Invite): string {
  const query = [`url=${encodeURIComponent(invite.url)}`];
  if (invite.clientId !== null) query.push(`clientId=${encodeURIComponent(invite.clientId)}`);
  return `${brand.protocolScheme}://join?${query.join('&')}`;
}

/** Whether a launch argument looks like one of this app's links: the OS passes them among other arguments. */
export function isAppLink(text: string): boolean {
  return text.toLowerCase().startsWith(`${brand.protocolScheme}:`);
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Reads an invite link. Anything but a join link with a valid git URL is refused. */
export function parseInviteLink(text: string): InviteCheck {
  if (text.length > INVITE_LINK_MAX) return { ok: false, problem: 'tooLong' };
  if (!isAppLink(text)) return { ok: false, problem: 'notInvite' };
  // `<scheme>://join?…`, `<scheme>://join/?…` and `<scheme>:join?…` are the same link.
  const rest = text.slice(brand.protocolScheme.length + 1);
  const question = rest.indexOf('?');
  const action = (question === -1 ? rest : rest.slice(0, question)).replace(/^\/\/|\/$/g, '');
  if (action.toLowerCase() !== 'join') return { ok: false, problem: 'action' };
  if (question === -1) return { ok: false, problem: 'url' };
  const query = rest.slice(question + 1);
  if (query.includes('#')) return { ok: false, problem: 'unknownPart' };
  const values = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const key = decode(equals === -1 ? pair : pair.slice(0, equals));
    const value = decode(equals === -1 ? '' : pair.slice(equals + 1));
    if (key === null || value === null) return { ok: false, problem: 'unknownPart' };
    if ((key !== 'url' && key !== 'clientId') || values.has(key)) return { ok: false, problem: 'unknownPart' };
    values.set(key, value);
  }
  const url = values.get('url');
  if (url === undefined || !parseGitUrl(url).ok) return { ok: false, problem: 'url' };
  const clientId = values.get('clientId') ?? null;
  if (clientId !== null && !CLIENT_ID.test(clientId)) return { ok: false, problem: 'clientId' };
  return { ok: true, invite: { url, clientId } };
}
