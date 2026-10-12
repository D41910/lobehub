import { isDesktop } from '@lobechat/const';
import type { ReplicaSyncSchedule } from '@lobechat/replica/zustand';
import type {
  DeviceGitAheadBehind,
  DeviceGitPullRequestActivity,
  DeviceGitPullRequestDetail,
  DeviceGitPullRequestDetailResult,
  DeviceGitPullRequestMergeContext,
  DeviceGitWorkingTreeStatus,
  DeviceGitWorktreeListItem,
} from '@lobechat/types';
import { useMemo } from 'react';

import { mutate, useClientDataSWR } from '@/libs/swr';
import { deviceKeys, localFileKeys } from '@/libs/swr/keys';
import { type GitBranchSummary, gitService } from '@/services/git';

import {
  gitLinkedPRKey,
  gitPullRequestKey,
  gitPullRequestMergeContextKey,
  type GitPullRequestMergeContextParams,
  type GitPullRequestParams,
  gitReviewPatchesKey,
  type GitReviewRead,
  type ReviewMode,
  type ReviewPatchesData,
} from './gitReview/projection';
import { type GitReviewStore, useGitReviewStore } from './gitReview/store';

export type { ReviewMode, ReviewPatchesData } from './gitReview/projection';
export { toReviewPatchesSummary } from './gitReview/projection';

const UNSTAGED_REVIEW_REFRESH_INTERVAL = 10 * 1000;
const BRANCH_REVIEW_REFRESH_INTERVAL = 30 * 1000;
const PULL_REQUEST_DETAIL_REFRESH_INTERVAL = 30 * 1000;

/**
 * Git read hooks for a working directory, transport-agnostic: the fetcher goes
 * through `gitService`, which dispatches Electron IPC (local) vs `device.*` RPC
 * (remote, `deviceId` set). UI only consumes these hooks — same call shape for
 * local and remote. Disabled (no request) until a `path` is available, and on
 * web (no `isDesktop`) until a `deviceId` is too.
 */
const isEnabled = (deviceId: string | undefined, path: string | undefined): path is string =>
  !!path && (!!deviceId || isDesktop);

export const getReviewRefreshInterval = (mode: ReviewMode, active: boolean) => {
  if (!active) return 0;
  return mode === 'branch' ? BRANCH_REVIEW_REFRESH_INTERVAL : UNSTAGED_REVIEW_REFRESH_INTERVAL;
};

interface GitReviewCacheParams {
  baseRef?: string;
  deviceId?: string;
  dirPath?: string;
  mode: ReviewMode;
}

export const getGitReviewPatchesKey = ({
  baseRef,
  deviceId,
  dirPath,
  mode,
}: GitReviewCacheParams) =>
  dirPath ? deviceKeys.gitReviewPatches(deviceId ?? 'local', dirPath, mode, baseRef ?? '') : null;

export const invalidateGitReviewCaches = async ({
  baseRef,
  deviceId,
  dirPath,
  mode,
}: GitReviewCacheParams) => {
  if (!dirPath) return;

  const cacheDeviceId = deviceId ?? 'local';
  await Promise.all([
    // The review replica syncs under this key, so this re-runs its read.
    mutate(deviceKeys.gitReviewPatches(cacheDeviceId, dirPath, mode, baseRef ?? '')),
    mutate(deviceKeys.gitWorkingTreeStatus(cacheDeviceId, dirPath)),
    mutate(deviceKeys.gitAheadBehind(cacheDeviceId, dirPath)),
    mutate(localFileKeys.gitWorkingTreeFiles(deviceId, dirPath)),
  ]);
};

export interface GitReplicaReadResult<T> {
  data: T | undefined;
  error: unknown;
  /** Nothing to paint yet (no persisted row, no response) and a read is pending. */
  isLoading: boolean;
  isValidating: boolean;
  /** Re-run the read (SWR-shaped, for the existing refresh callers). */
  mutate: () => Promise<unknown>;
}

interface ReplicaReadSlice<TParams> {
  useSync: (
    params: TParams | null | undefined,
    options?: ReplicaSyncSchedule & { shouldRetryOnError?: boolean },
  ) => {
    error: unknown;
    isHydrated: boolean;
    isValidating: boolean;
    revalidate: () => Promise<unknown>;
  };
}

/**
 * Read one of the Review / PR replicas (see `./gitReview`): the persisted row
 * paints first, the device read confirms it in the background. Returns the
 * SWR-like shape the Review / PR tabs were written against.
 */
const useGitReviewReplica = <TParams, TStored>(
  pick: (slices: GitReviewStore['slices']) => ReplicaReadSlice<TParams>,
  selectMap: (state: GitReviewStore) => Record<string, TStored>,
  toKey: (params: TParams) => string,
  params: TParams | null,
  schedule: ReplicaSyncSchedule,
) => {
  const key = params ? toKey(params) : undefined;
  const stored = useGitReviewStore((s) => (key ? selectMap(s)[key] : undefined));
  // The driver forwards SWR options as given: a failed git read (dead path,
  // unreachable device, missing `gh`) is not retried, like the SWR hooks these replaced.
  const { error, isHydrated, isValidating, revalidate } = pick(
    useGitReviewStore.getState().slices,
  ).useSync(params, { ...schedule, shouldRetryOnError: false });

  return {
    error,
    isLoading: !!params && stored === undefined && !error && (!isHydrated || isValidating),
    isValidating,
    mutate: revalidate,
    stored,
  };
};

/** A `GitReviewRead` replica, unwrapped into the SWR-shaped result. */
const useGitReviewRead = <TParams, T>(
  pick: (slices: GitReviewStore['slices']) => ReplicaReadSlice<TParams>,
  selectMap: (state: GitReviewStore) => Record<string, GitReviewRead<T>>,
  toKey: (params: TParams) => string,
  params: TParams | null,
  schedule: ReplicaSyncSchedule,
): GitReplicaReadResult<T> => {
  const { stored, ...rest } = useGitReviewReplica(pick, selectMap, toKey, params, schedule);
  return { ...rest, data: stored?.value };
};

/**
 * Review tab diff. A replica: after a reload the persisted summary (paths +
 * line counts, `summaryOnly`, no diff text) paints first, and the live read
 * replaces it with the full diff.
 */
export const useReviewPatches = (
  dirPath: string | undefined,
  mode: ReviewMode,
  baseRef?: string,
  deviceId?: string,
  active = true,
): GitReplicaReadResult<ReviewPatchesData> => {
  const enabled = active && isEnabled(deviceId, dirPath);
  const params = useMemo(
    () => (enabled ? { baseRef, deviceId, mode, path: dirPath! } : null),
    [enabled, baseRef, deviceId, mode, dirPath],
  );
  const { stored, ...rest } = useGitReviewReplica(
    (slices) => slices.reviewPatches,
    (s) => s.gitReviewPatchesMap,
    gitReviewPatchesKey,
    params,
    {
      focusThrottleInterval: mode === 'branch' ? 30 * 1000 : 5 * 1000,
      refreshInterval: getReviewRefreshInterval(mode, active),
      refreshWhenHidden: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
  return { ...rest, data: stored };
};

/**
 * Current branch + detached state. A cheap local git read, so use a short
 * dedupe window (2s): switching the working directory must refetch the branch
 * promptly. A longer window would swallow SWR's key-change revalidation and
 * leave the branch label stuck on the previous directory (only a manual
 * `mutate()` refresh would recover it). 2s still collapses truly concurrent
 * reads of the same dir.
 */
export const useFetchGitBranch = (deviceId: string | undefined, path?: string) =>
  useClientDataSWR<GitBranchSummary>(
    isEnabled(deviceId, path) ? deviceKeys.gitBranch(deviceId ?? 'local', path) : null,
    () => gitService.getGitBranch({ deviceId, path: path! }),
    { dedupingInterval: 2 * 1000, shouldRetryOnError: false },
  );

/**
 * PR linked to the current branch. The lookup spawns `gh pr list` (8s timeout),
 * so keep a long 60s dedupe + 60s focus throttle — unlike the cheap branch read,
 * this must NOT re-run on every remount or directory revisit. Keyed by branch,
 * so a checkout naturally re-keys into a fresh lookup; disabled for non-github
 * repos and detached HEAD (no branch ref to query). Includes merged/closed PRs
 * so the lifecycle badge can refresh after GitHub changes outside the app.
 */
export const useFetchGitLinkedPR = (
  deviceId: string | undefined,
  path: string | undefined,
  branch: string | undefined,
  isGithub = false,
) => {
  const enabled = isGithub && !!branch && isEnabled(deviceId, path);
  const params = useMemo(
    () => (enabled ? { branch: branch!, deviceId, path: path! } : null),
    [enabled, branch, deviceId, path],
  );
  return useGitReviewRead(
    (slices) => slices.linkedPR,
    (s) => s.gitLinkedPRMap,
    gitLinkedPRKey,
    params,
    { dedupingInterval: 60 * 1000, focusThrottleInterval: 60 * 1000 },
  );
};

/**
 * Working-tree dirty-file counts. Revalidates on focus (5s throttle) so the
 * +N ~M -K badge tracks edits when the user switches back to the window.
 */
export const useFetchGitWorkingTreeStatus = (deviceId: string | undefined, path?: string) =>
  useClientDataSWR<DeviceGitWorkingTreeStatus | undefined>(
    isEnabled(deviceId, path) ? deviceKeys.gitWorkingTreeStatus(deviceId ?? 'local', path) : null,
    () => gitService.getGitWorkingTreeStatus({ deviceId, path: path! }),
    { focusThrottleInterval: 5 * 1000, revalidateOnFocus: true, shouldRetryOnError: false },
  );

/**
 * Ahead/behind commit counts. Each load piggybacks a best-effort `git fetch`
 * inside the read, so focus revalidation (5s throttle) surfaces remote updates.
 */
export const useFetchGitAheadBehind = (deviceId: string | undefined, path?: string) =>
  useClientDataSWR<DeviceGitAheadBehind | undefined>(
    isEnabled(deviceId, path) ? deviceKeys.gitAheadBehind(deviceId ?? 'local', path) : null,
    () => gitService.getGitAheadBehind({ deviceId, path: path! }),
    { focusThrottleInterval: 5 * 1000, revalidateOnFocus: true, shouldRetryOnError: false },
  );

/**
 * Worktrees attached to the same repository as the current working directory.
 * Revalidates on focus so temp PR worktrees created outside the app appear
 * without restarting the conversation.
 */
export const useFetchGitWorktrees = (deviceId: string | undefined, path?: string) =>
  useClientDataSWR<DeviceGitWorktreeListItem[]>(
    isEnabled(deviceId, path) ? deviceKeys.gitWorktrees(deviceId ?? 'local', path) : null,
    () => gitService.listGitWorktrees({ deviceId, path: path! }),
    { focusThrottleInterval: 5 * 1000, revalidateOnFocus: true, shouldRetryOnError: false },
  );

export const pullRequestDetailRefreshInterval = (
  detail: DeviceGitPullRequestDetailResult | undefined,
  active: boolean,
): number => {
  if (!active || !detail?.detail || detail.detail.state !== 'open') return 0;
  const isPending =
    !!detail.detail.autoMerge ||
    detail.detail.reviewDecision === 'REVIEW_REQUIRED' ||
    detail.detail.reviewDecision === 'CHANGES_REQUESTED' ||
    detail.detail.mergeStateStatus === 'BLOCKED' ||
    detail.detail.mergeable === 'UNKNOWN' ||
    detail.detail.checks.some((c) => c.status === 'pending');
  return isPending ? PULL_REQUEST_DETAIL_REFRESH_INTERVAL : 0;
};

/**
 * Full pull request detail for the Working Sidebar's Pull Request tab. Polls
 * every 30s while checks, reviews, auto-merge, or mergeability haven't resolved
 * yet, and stops once the PR settles into a steady state.
 */
export const useFetchGitPullRequestDetail = (
  deviceId: string | undefined,
  path: string | undefined,
  number: number | undefined,
  { active = true }: { active?: boolean } = {},
) => {
  const enabled = number !== undefined && isEnabled(deviceId, path);
  const params = useMemo(
    () => (enabled ? { deviceId, number: number!, path: path! } : null),
    [enabled, deviceId, number, path],
  );
  return useGitReviewRead(
    (slices) => slices.pullRequestDetail,
    (s) => s.gitPullRequestDetailMap,
    gitPullRequestKey,
    params,
    {
      dedupingInterval: 30_000,
      focusThrottleInterval: 60 * 1000,
      refreshInterval: (latest?: GitReviewRead<DeviceGitPullRequestDetailResult>) =>
        pullRequestDetailRefreshInterval(latest?.value, active),
      revalidateOnFocus: true,
    },
  );
};

/** Activity starts once core data can paint; its failure never hides the PR. */
export const useFetchGitPullRequestActivity = (
  deviceId: string | undefined,
  path: string | undefined,
  number: number | undefined,
  active = true,
) => {
  const enabled = number !== undefined && isEnabled(deviceId, path);
  const params = useMemo(
    () => (enabled ? { deviceId, number: number!, path: path! } : null),
    [enabled, deviceId, number, path],
  );
  return useGitReviewRead<GitPullRequestParams, DeviceGitPullRequestActivity>(
    (slices) => slices.pullRequestActivity,
    (s) => s.gitPullRequestActivityMap,
    gitPullRequestKey,
    params,
    {
      dedupingInterval: 30_000,
      focusThrottleInterval: 60_000,
      refreshInterval: active ? 30_000 : 0,
    },
  );
};

/**
 * Slow merge context (permission, branch protection, base drift), keyed on the
 * PR head so a push refetches it. Runs after the detail so the pane paints first.
 */
export const useFetchGitPullRequestMergeContext = (
  deviceId: string | undefined,
  path: string | undefined,
  detail:
    Pick<DeviceGitPullRequestDetail, 'baseRefName' | 'headRefOid' | 'number' | 'repo'> | undefined,
) => {
  const enabled = !!detail && isEnabled(deviceId, path);
  const { baseRefName, headRefOid, number } = detail ?? {};
  const repoName = detail?.repo.name;
  const repoOwner = detail?.repo.owner;
  const params = useMemo(
    () =>
      enabled
        ? {
            baseRefName: baseRefName!,
            deviceId,
            headRefOid: headRefOid!,
            number: number!,
            path: path!,
            repo: { name: repoName!, owner: repoOwner! },
          }
        : null,
    [enabled, baseRefName, deviceId, headRefOid, number, path, repoName, repoOwner],
  );
  return useGitReviewRead<
    GitPullRequestMergeContextParams,
    DeviceGitPullRequestMergeContext | null
  >(
    (slices) => slices.pullRequestMergeContext,
    (s) => s.gitPullRequestMergeContextMap,
    gitPullRequestMergeContextKey,
    params,
    { dedupingInterval: 30_000, focusThrottleInterval: 60 * 1000, revalidateOnFocus: true },
  );
};

/**
 * Lazy-loaded list of remote branches under `refs/remotes/origin/*`.
 * Disabled until the Review base-ref picker opens.
 */
export const useGitRemoteBranches = (
  dirPath: string | undefined,
  enabled: boolean,
  deviceId?: string,
) => {
  const key =
    enabled && dirPath ? deviceKeys.gitRemoteBranches(deviceId ?? 'local', dirPath) : null;
  return useClientDataSWR(
    key,
    () => gitService.listGitRemoteBranches({ deviceId, path: dirPath! }),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
};
