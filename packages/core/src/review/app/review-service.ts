// Roles, change requests and signing (IMPLEMENTATION.md Step 12, PLAN.md §3.11, ADR 0032): the host decides, the app
// mirrors. The role the host gave decides which actions each screen shows; pushes the role can't make are refused
// before they reach the server (the server would refuse them anyway). A rejection is never a dead end: a protected
// branch offers a change request, and missing signatures offer to sign the unpushed commits and push again. The
// request itself is made, reviewed and merged on the host's website.
import type { HostKindName, RoleName } from '@app/schemas';
import { defineCommand, defineQuery } from '../../engine/index.ts';
import type { PushRejection } from '../../ports/git.ts';
import { AppError } from '../../shared/errors.ts';
import type { CommitConfirmations, CommitResult, PushResult, SyncReviewHooks } from '../../sync/index.ts';
import { isRequestBranch } from '../domain/requests.ts';
import { actionsFor, type RoleActions } from '../domain/roles.ts';
import { type OpenResult, RequestFlow } from './requests.ts';
import { accountOf, type ReviewDeps, settingsOf, updateSettings } from './review-context.ts';
import { SigningFlow, type SigningView } from './signing.ts';

type NoInput = Record<string, never>;

export interface ReviewStatus {
  /** null for a library without a sign-in (a test library): nothing is gated there. */
  readonly role: RoleName | null;
  readonly host: HostKindName | null;
  readonly login: string | null;
  readonly actions: RoleActions | null;
  readonly branch: string | null;
  readonly companyBranch: string;
  readonly onCompanyBranch: boolean;
  /**
   * The current branch is one of the user's own for a change request (PLAN.md §3.11): a `requests/*` branch, or any
   * branch but the company's of a Member (who can't push elsewhere). A Maintainer's other branches are plain branches.
   */
  readonly requestBranch: boolean;
  /** The host refused a direct push here: Member from then on (GitHub's classic protection). */
  readonly directPushRefused: boolean;
  readonly signingRequired: boolean;
  readonly signingKeyNeeded: boolean;
}

export const ReviewStatusQuery = defineQuery<NoInput, ReviewStatus>('ReviewStatus');
export const SuggestBranchQuery = defineQuery<{ skills: readonly string[] }, string>('SuggestBranch');
export const SigningQuery = defineQuery<NoInput, SigningView>('Signing');

export const CommitToNewBranch = defineCommand<
  { paths: readonly string[]; message: string; branch: string; confirm: CommitConfirmations },
  CommitResult
>('CommitToNewBranch');
export const OpenRequest = defineCommand<{ confirmSecrets: boolean }, OpenResult>('OpenRequest');
export const MoveCommits = defineCommand<{ branch: string }, void>('MoveCommits');
export const ChooseSigningKey = defineCommand<{ path: string; publicKey: string }, void>('ChooseSigningKey');
export const CreateSigningKey = defineCommand<NoInput, void>('CreateSigningKey');
export const RegisterSigningKey = defineCommand<NoInput, void>('RegisterSigningKey');
export const SignAndPush = defineCommand<{ confirmSecrets: boolean }, PushResult>('SignAndPush');

export class ReviewService {
  readonly requests: RequestFlow;
  readonly signing: SigningFlow;
  readonly #deps: ReviewDeps;
  #companyBranch: string | null = null;

  constructor(deps: ReviewDeps) {
    this.#deps = deps;
    const changed = () => deps.onChange();
    this.requests = new RequestFlow(deps, changed);
    this.signing = new SigningFlow(deps, changed);
    const { engine, sync } = deps;
    sync.useReview(this.hooks());

    engine.handleQuery(ReviewStatusQuery, () => this.status());
    engine.handleQuery(SuggestBranchQuery, ({ skills }) => this.requests.suggest(skills));
    engine.handleQuery(SigningQuery, () => this.signing.view());

    engine.handle(CommitToNewBranch, (input, context) =>
      this.requests.commitToNewBranch(input, (event) => context.emit(event)),
    );
    engine.handle(OpenRequest, (input, context) =>
      this.#writer(() => this.requests.open(input, (event) => context.emit(event))),
    );
    engine.handle(MoveCommits, ({ branch }) => this.requests.moveCommits(branch));
    engine.handle(ChooseSigningKey, ({ path, publicKey }) => this.signing.choose(path, publicKey));
    engine.handle(CreateSigningKey, () => this.signing.create());
    engine.handle(RegisterSigningKey, () => this.signing.register());
    engine.handle(SignAndPush, ({ confirmSecrets }, context) =>
      this.signing.signAndPush(confirmSecrets, (e) => context.emit(e)),
    );
  }

  /** What the git screens ask of the review module (sync's hooks). */
  hooks(): SyncReviewHooks {
    return {
      checkPush: (branch) => this.#checkPush(branch),
      pushRejected: (reason, branch) => this.#pushRejected(reason, branch),
      signingKeyNeeded: () => this.signing.keyNeeded(),
    };
  }

  async #company(): Promise<string> {
    this.#companyBranch ??= await this.requests.companyBranch();
    return this.#companyBranch;
  }

  async status(): Promise<ReviewStatus> {
    const { store, repo } = this.#deps;
    const account = accountOf(store);
    const settings = settingsOf(store);
    const branch = (await repo.status()).branch;
    const company = await this.#company();
    const onCompanyBranch = branch === company;
    const actions = account ? actionsFor(account.role, account.host) : null;
    return {
      role: account?.role ?? null,
      host: account?.host ?? null,
      login: account?.login ?? null,
      actions,
      branch,
      companyBranch: company,
      onCompanyBranch,
      requestBranch:
        branch !== null &&
        !onCompanyBranch &&
        (actions === null || actions.requests) &&
        (isRequestBranch(branch) || actions?.companyBranch === 'request'),
      directPushRefused: settings.directPushRefused,
      signingRequired: settings.signingRequired,
      signingKeyNeeded: this.signing.keyNeeded(),
    };
  }

  /** The role's actions, or null when nothing is gated (no sign-in: a test library). */
  #actions(): RoleActions | null {
    const account = accountOf(this.#deps.store);
    return account ? actionsFor(account.role, account.host) : null;
  }

  async #checkPush(branch: string): Promise<void> {
    const actions = this.#actions();
    if (actions === null) return;
    if (actions.companyBranch === 'none') throw new AppError('review.notAllowed', { action: 'push' });
    if (actions.companyBranch === 'request' && branch === (await this.#company())) {
      throw new AppError('review.notAllowed', { action: 'pushCompanyBranch' });
    }
  }

  async #writer<T>(fn: () => Promise<T>): Promise<T> {
    const actions = this.#actions();
    if (actions !== null && !actions.requests) throw new AppError('review.notAllowed', { action: 'request' });
    return fn();
  }

  /**
   * What a rejected push teaches (PLAN.md §3.10, §3.11): required signatures; and a refused direct push to the company
   * branch, which makes a GitHub Write user on a classically protected branch a Member from now on. The role is asked
   * for again after every rejection.
   */
  async #pushRejected(reason: PushRejection, branch: string): Promise<void> {
    if (reason === 'unsigned') this.signing.learnRequired();
    if (reason === 'protected' && branch === (await this.#company())) {
      updateSettings(this.#deps.store, { directPushRefused: true });
    }
    if (reason !== 'nonFastForward') this.#deps.recheckAccess();
    this.#deps.onChange();
  }
}
