// The daily update check (PLAN.md §3.19 "App updates", Step 18; ADR 0031): once a day, and on [Check now], main reads
// the update feed of this system (update-feed.ts) and refreshes the signed tool catalog (catalog-refresh.ts). A newer
// version is only shown: [Download] opens its release page, and the user downloads and installs it. The app downloads
// and installs nothing itself. The check sends nothing but its requests for the two files (PLAN.md §3.19 "Telemetry").
import { AppError, type Clock, compareVersions, type Logger, type Timer } from '@app/core';
import type { UpdateView } from '@app/ipc';
import { allowedReleaseUrl, type CatalogRefreshResult, type FetchedFile } from './catalog-refresh.ts';
import { inRollout, parseFeed } from './update-feed.ts';

export const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** The first check waits a little after the start, so it never slows the start down. */
export const FIRST_CHECK_AFTER_MS = 2 * 60 * 1000;
/** A feed request that never answers ends after this; the next check starts again. */
export const CHECK_TIMEOUT_MS = 2 * 60 * 1000;

/** Network failures that mean "offline", as Chromium and Node name them. */
const OFFLINE =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/;

export interface UpdateServiceDeps {
  readonly version: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The device's id (device.json): it places the device in a staged rollout (ADR 0027). */
  readonly deviceId: () => string;
  /** The feed of this system, and the page each version is downloaded from (release-feed.ts); null without a feed. */
  readonly feed: { readonly url: string | null; releasePage(version: string): string | null };
  readonly fetchFile: (url: string) => Promise<FetchedFile>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly catalog: {
    refresh(): Promise<CatalogRefreshResult>;
    /** The catalog the app uses now: the bundled one or a refreshed one, and why a saved one isn't used. */
    current(): Promise<{ readonly source: 'bundled' | 'refreshed'; readonly rejected: string | null }>;
  };
  /** A refreshed catalog was saved: the workers load it when they start again. */
  readonly onCatalogSaved: () => void;
  readonly onChange: (view: UpdateView) => void;
}

type Phase = UpdateView['phase'];
type CatalogRejected = UpdateView['catalog']['rejected'];

export class UpdateService {
  readonly #deps: UpdateServiceDeps;
  #phase: Phase = 'idle';
  #available: string | null = null;
  #dismissed = false;
  #lastCheckedAt: number | null = null;
  #error: UpdateView['error'] = null;
  #catalog: UpdateView['catalog'] = { source: 'bundled', refreshedAt: null, rejected: null };
  #timer: Timer | undefined;
  #running: Promise<UpdateView> | undefined;

  constructor(deps: UpdateServiceDeps) {
    this.#deps = deps;
  }

  /** Reads the catalog in use, and plans the first check. */
  async start(): Promise<void> {
    const current = await this.#deps.catalog.current();
    this.#catalog = { ...this.#catalog, source: current.source, rejected: this.#rejection(current.rejected) };
    this.#schedule(FIRST_CHECK_AFTER_MS);
  }

  stop(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  view(): UpdateView {
    return {
      version: this.#deps.version,
      supported: this.#deps.feed.url !== null,
      phase: this.#phase,
      available: this.#available,
      dismissed: this.#dismissed,
      lastCheckedAt: this.#lastCheckedAt === null ? null : new Date(this.#lastCheckedAt).toISOString(),
      error: this.#error,
      catalog: this.#catalog,
    };
  }

  /** The daily check, or [Check now]: the app and the catalog together. A check already running is joined. */
  check(): Promise<UpdateView> {
    this.#running ??= this.#check().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** [Download]: the newer version's release page opens in the browser. */
  async openDownload(): Promise<void> {
    const page = this.#available === null ? null : this.#deps.feed.releasePage(this.#available);
    if (this.#phase !== 'available' || page === null) throw new AppError('update.notAvailable');
    this.#deps.logger.info('update download page opened', { version: this.#available });
    await this.#deps.openExternal(page);
  }

  /** [Later]: the banner goes until a newer version is out, or the app starts again. */
  dismiss(): void {
    if (this.#phase !== 'available' || this.#dismissed) return;
    this.#dismissed = true;
    this.#changed();
  }

  async #check(): Promise<UpdateView> {
    this.#timer?.cancel();
    const app = this.#checkApp();
    const catalog = this.#deps.catalog
      .refresh()
      .catch((error: unknown): CatalogRefreshResult => ({ outcome: 'failed', message: String(error).slice(0, 300) }));
    const [, refreshed] = await Promise.all([app, catalog]);
    this.#lastCheckedAt = this.#deps.clock.now();
    if (refreshed.outcome === 'saved') {
      this.#catalog = { source: 'refreshed', refreshedAt: new Date(this.#lastCheckedAt).toISOString(), rejected: null };
      this.#deps.onCatalogSaved();
    } else if (refreshed.outcome === 'rejected') {
      this.#catalog = { ...this.#catalog, rejected: refreshed.reason };
    } else if (refreshed.outcome === 'failed') {
      this.#catalog = { ...this.#catalog, rejected: 'failed' };
    } else if (refreshed.outcome === 'same') {
      this.#catalog = { ...this.#catalog, rejected: null };
    }
    this.#deps.logger.info('update check done', {
      phase: this.#phase,
      available: this.#available,
      catalog: refreshed.outcome,
    });
    this.#schedule(UPDATE_CHECK_EVERY_MS);
    this.#changed();
    return this.view();
  }

  /** Reads the feed: a newer version that this device is in the rollout of is available; anything else is not. */
  async #checkApp(): Promise<void> {
    const { feed, logger, version } = this.#deps;
    if (feed.url === null) return;
    this.#phase = 'checking';
    this.#error = null;
    this.#changed();
    try {
      if (!allowedReleaseUrl(feed.url)) throw new Error('address not allowed');
      const file = await this.#withinLimit(this.#deps.fetchFile(feed.url));
      if (file.status !== 200) throw new Error(`HTTP ${file.status}`);
      const latest = parseFeed(new TextDecoder().decode(file.bytes));
      if (latest === null) throw new Error('the feed has no version');
      const newer =
        compareVersions(latest.version, version) > 0 &&
        inRollout(this.#deps.deviceId(), latest.version, latest.rolloutPercent);
      if (newer) {
        if (this.#available !== latest.version) this.#dismissed = false;
        this.#phase = 'available';
        this.#available = latest.version;
        logger.info('a newer version is available', { version: latest.version });
      } else {
        this.#phase = 'up-to-date';
        this.#available = null;
        this.#dismissed = false;
        if (latest.rolloutPercent < 100) {
          logger.info('the newest version is in a staged rollout', {
            version: latest.version,
            percent: latest.rolloutPercent,
          });
        }
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      this.#phase = 'failed';
      this.#error = { code: OFFLINE.test(message) ? 'update.offline' : 'update.failed', params: {} };
      logger.warn('the update check failed', { message });
    }
  }

  /** A request that never answers fails after CHECK_TIMEOUT_MS. */
  #withinLimit<T>(request: Promise<T>): Promise<T> {
    let limit: Timer | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      limit = this.#deps.clock.setTimer(CHECK_TIMEOUT_MS, () => reject(new Error('ETIMEDOUT')));
    });
    return Promise.race([request, timedOut]).finally(() => limit?.cancel());
  }

  #schedule(ms: number): void {
    this.#timer?.cancel();
    this.#timer = this.#deps.clock.setTimer(ms, () => void this.check());
  }

  #rejection(reason: string | null): CatalogRejected {
    const known = ['unreadable', 'unknownKey', 'badSignature', 'invalid', 'newerSchema', 'failed'] as const;
    return (known as readonly string[]).includes(reason ?? '') ? (reason as CatalogRejected) : null;
  }

  #changed(): void {
    this.#deps.onChange(this.view());
  }
}
