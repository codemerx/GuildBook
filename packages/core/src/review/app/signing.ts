// Commit signing (PLAN.md §3.10 "Signing"): where the host requires signed commits, the app signs with an SSH key. It
// asks once which key, or creates one; it offers to register the key as a signing key through the API on GitHub and
// GitLab (a signature shows as verified only then), and explains how elsewhere. The requirement is known from the
// branch rules where they're readable; otherwise the first rejected push tells, and the app offers [Sign my unpushed
// commits and push again].
import type { GitSigning } from '../../ports/git.ts';
import { AppError, isAppError } from '../../shared/errors.ts';
import type { DomainEvent } from '../../shared/events.ts';
import { identityOf, type PushResult } from '../../sync/index.ts';
import { keyLabel, keyTitle, parsePublicKey, sameKey } from '../domain/signing.ts';
import { type ReviewDeps, settingsOf, SIGNING_KEY_SECRET, updateSettings } from './review-context.ts';

export interface SigningKeyView {
  readonly kind: 'file' | 'app';
  /** The public key file, for one of the user's own keys. */
  readonly path: string | null;
  readonly publicKey: string;
  readonly label: string;
}

export interface SigningView {
  readonly required: boolean;
  readonly key: SigningKeyView | null;
  /** The host takes signing keys through its API (GitHub, GitLab); elsewhere the app explains how. */
  readonly canRegister: boolean;
  /** Whether the chosen key is registered on the host as a signing key; null when the host can't say. */
  readonly registered: boolean | null;
}

export class SigningFlow {
  readonly #deps: ReviewDeps;
  readonly #changed: () => void;

  constructor(deps: ReviewDeps, changed: () => void) {
    this.#deps = deps;
    this.#changed = changed;
  }

  /** Commits need a key, and none is chosen yet. */
  keyNeeded(): boolean {
    const settings = settingsOf(this.#deps.store);
    return settings.signingRequired && settings.signingKey === null;
  }

  /** How git signs the library's commits now, or null where the host doesn't require it. */
  async gitSigning(): Promise<GitSigning | null> {
    const settings = settingsOf(this.#deps.store);
    const key = settings.signingKey;
    if (!settings.signingRequired || key === null) return null;
    if (key.kind === 'file') return { kind: 'file', path: key.path };
    const privateKey = await this.#deps.services.secret(SIGNING_KEY_SECRET);
    if (privateKey === null) throw new AppError('review.keyNotFound');
    return { kind: 'key', privateKey };
  }

  async view(): Promise<SigningView> {
    const settings = settingsOf(this.#deps.store);
    const key = settings.signingKey;
    const api = await this.#deps.api();
    const canRegister = api?.host.capabilities().signingKeyRegistration ?? false;
    let registered: boolean | null = null;
    if (api && canRegister && key) {
      const keys = await api.host.signingKeys(api.token).catch(() => null);
      registered = keys === null ? null : keys.some((k) => sameKey(k.key, key.publicKey));
    }
    return {
      required: settings.signingRequired,
      key: key
        ? {
            kind: key.kind,
            path: key.kind === 'file' ? key.path : null,
            publicKey: key.publicKey,
            label: keyLabel(key.publicKey),
          }
        : null,
      canRegister,
      registered,
    };
  }

  /**
   * One of the user's own keys: the public key file the user picked in a file dialog, and its line, which main read
   * (PLAN.md §3.7 rule 5). The worker opens no file in the user's SSH folder.
   */
  async choose(path: string, publicKey: string): Promise<void> {
    const line = publicKey.trim();
    if (!parsePublicKey(line)) throw new AppError('review.keyInvalid');
    updateSettings(this.#deps.store, {
      signingKey: { kind: 'file', path: this.#deps.keys.signWith(path), publicKey: line },
    });
    this.#changed();
  }

  /** A new key the app keeps, for a user who signed in with a token and has none (PLAN.md §3.10). */
  async create(): Promise<void> {
    const { keys, services, store, deviceName, appName } = this.#deps;
    const key = keys.create(keyTitle(appName, deviceName()));
    await services.setSecret(SIGNING_KEY_SECRET, key.privateKey);
    updateSettings(store, { signingKey: { kind: 'app', publicKey: key.publicKey } });
    this.#changed();
  }

  /** Registers the chosen key on the host as a signing key; one already there is fine. */
  async register(): Promise<void> {
    const { store, deviceName, appName, activity } = this.#deps;
    const key = settingsOf(store).signingKey;
    if (!key) throw new AppError('review.signingKeyNeeded');
    const api = await this.#deps.api();
    if (!api || !api.host.capabilities().signingKeyRegistration) throw new AppError('review.noApi');
    const existing = await api.host.signingKeys(api.token);
    if (!existing.some((k) => sameKey(k.key, key.publicKey))) {
      await api.host.addSigningKey(api.token, { title: keyTitle(appName, deviceName()), key: key.publicKey });
      activity.append([{ kind: 'signing-key-added', path: null, details: { key: keyLabel(key.publicKey) } }]);
    }
    this.#changed();
  }

  /** The host requires signed commits: from its rules, or a rejected push. */
  learnRequired(): void {
    if (settingsOf(this.#deps.store).signingRequired) return;
    updateSettings(this.#deps.store, { signingRequired: true });
    this.#changed();
  }

  /**
   * [Sign my unpushed commits and push again]: the commits the server doesn't have yet are made again, signed (their
   * authors and dates of authorship stay), and pushed.
   */
  async signAndPush(confirmSecrets: boolean, emit: (event: DomainEvent) => void): Promise<PushResult> {
    const { repo, sync, store } = this.#deps;
    if (this.keyNeeded() || settingsOf(store).signingKey === null) throw new AppError('review.signingKeyNeeded');
    if (!settingsOf(store).signingRequired) updateSettings(store, { signingRequired: true });
    const identity = identityOf(store);
    if (!identity) throw new AppError('sync.identityNeeded');
    const status = await repo.status();
    if (status.branch === null) throw new AppError('sync.detached');
    const unpushed = await sync.commits.notPushed(status.upstream);
    if (unpushed.length > 0) {
      const oldest = unpushed.at(-1)!;
      const base = oldest.parents[0];
      if (base === undefined) throw new AppError('sync.noUpstream');
      try {
        await sync.own(() => repo.signCommits(base, identity));
      } catch (error) {
        if (isAppError(error) && error.code === 'git.failed') {
          throw new AppError('review.signingFailed', { message: String(error.params.message ?? '') });
        }
        throw error;
      }
    }
    await sync.changed();
    return sync.commits.push({ confirmSecrets }, emit);
  }
}
