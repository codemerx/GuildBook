// The review module (IMPLEMENTATION.md §2.3, PLAN.md §3.11): roles from host facts (Step 4); role gating, the branches
// of change requests (made on the host's website, ADR 0032) and commit signing (Step 12).
export {
  actionsFor,
  adminActions,
  canPush,
  classicProtection,
  GITLAB_DEVELOPER,
  GITLAB_GUEST,
  GITLAB_MAINTAINER,
  GITLAB_OWNER,
  GITLAB_REPORTER,
  type Role,
  type RoleActions,
  roleFrom,
  roles,
  roleWithRefusal,
} from './domain/roles.ts';
export { isRequestBranch, REQUEST_PREFIX, requestLinkFrom, slug, suggestBranch } from './domain/requests.ts';
export { keyLabel, keyTitle, parsePublicKey, type PublicKey, sameKey } from './domain/signing.ts';
export { accountOf, type ReviewApi, type ReviewDeps, SIGNING_KEY_SECRET } from './app/review-context.ts';
export { type OpenResult, RequestFlow, type ServerBranch } from './app/requests.ts';
export { SigningFlow, type SigningKeyView, type SigningView } from './app/signing.ts';
export {
  ChooseSigningKey,
  CommitToNewBranch,
  CreateSigningKey,
  MoveCommits,
  OpenRequest,
  RegisterSigningKey,
  ReviewService,
  type ReviewStatus,
  ReviewStatusQuery,
  SignAndPush,
  SigningQuery,
  SuggestBranchQuery,
} from './app/review-service.ts';
