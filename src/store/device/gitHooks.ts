import { isDesktop } from '@lobechat/const';
import type {
  GitWorkingTreePatch,
  SubmoduleWorkingTreePatches,
} from '@lobechat/electron-client-ipc';
import type {
  DeviceGitAheadBehind,
  DeviceGitPullRequestActivity,
  DeviceGitPullRequestDetail,
  DeviceGitPullRequestDetailResult,
  DeviceGitPullRequestMergeContext,
  DeviceGitWorkingTreeStatus,
  DeviceGitWorktreeListItem,
} from '@lobechat/types';

import { mutate, useClientDataSWR } from '@/libs/swr';
import { deviceKeys, localFileKeys } from '@/libs/swr/keys';
import { type GitBranchSummary, type GitLinkedPRSummary, gitService } from '@/services/git';

export type ReviewMode = 'unstaged' | 'branch';

const UNSTAGED_REVIEW_REFRESH_INTERVAL = 10 * 1000;
const BRANCH_REVIEW_REFRESH_INTERVAL = 30 * 1000;
const PULL_REQUEST_DETAIL_REFRESH_INTERVAL = 30 * 1000;

export interface ReviewPatchesData {
  baseRef?: string;
  headRef?: string;
  mode: ReviewMode;
  patches: GitWorkingTreePatch[];
  /**
   * Per-submodule patch groups. Undefined when the parent has no dirty
   * submodules (unstaged) or no submodule pointer differences (branch).
   */
  submodules?: SubmoduleWorkingTreePatches[];
  /**
   * Set on the persisted summary (see `toReviewPatchesSummary`): paths and
   * line counts are real, but every `patch` body is empty until the live read
   * lands.
   */
  summaryOnly?: boolean;
}

const summarizePatch = ({
  additions,
  deletions,
  filePath,
  isBinary,
  status,
  truncated,
}: GitWorkingTreePatch): GitWorkingTreePatch => ({
  additions,
  deletions,
  filePath,
  isBinary,
  patch: '',
  status,
  truncated,
});

/**
 * The persistable shape of a review read: file paths, statuses and +/- counts
 * without diff text, which can run to megabytes and is cheap to re-read.
 */
export const toReviewPatchesSummary = (data: ReviewPatchesData): ReviewPatchesData => ({
  baseRef: data.baseRef,
  headRef: data.headRef,
  mode: data.mode,
  patches: data.patches.map(summarizePatch),
  submodules: data.submodules?.map((sub) => ({ ...sub, patches: sub.patches.map(summarizePatch) })),
  summaryOnly: true,
});

/**
 * Git read hooks for a working directory, transport-agnostic: the fetcher goes
 * through `gitService`, which dispatches Electron IPC (local) vs `device.*` RPC
 * (remote, `deviceId` set). UI only consumes these hooks — same call shape for
 * local and remote. Disabled (no request) until a `path` is available, and on
 * web (no `isDesktop`) until a `deviceId` is too.
 */
const isEnabled = (deviceId: string | undefined, path: string | undefined): path is string =>
  !!path && (!!deviceId || isDesktop);

const fetchUnstagedReviewPatches = async (
  dirPath: string,
  deviceId: string | undefined,
): Promise<ReviewPatchesData> => {
  const result = await gitService.getGitWorkingTreePatches({ deviceId, path: dirPath });
  return { mode: 'unstaged', patches: result?.patches ?? [], submodules: result?.submodules };
};

const fetchBranchReviewPatches = async (
  dirPath: string,
  baseRef: string | undefined,
  deviceId: string | undefined,
): Promise<ReviewPatchesData> => {
  const result = await gitService.getGitBranchDiff({ baseRef, deviceId, path: dirPath });
  return {
    baseRef: result?.baseRef,
    headRef: result?.headRef,
    mode: 'branch',
    patches: result?.patches ?? [],
    submodules: result?.submodules,
  };
};

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

export const getGitReviewSummaryKey = ({
  baseRef,
  deviceId,
  dirPath,
  mode,
}: GitReviewCacheParams) =>
  dirPath ? deviceKeys.gitReviewSummary(deviceId ?? 'local', dirPath, mode, baseRef ?? '') : null;

export const invalidateGitReviewCaches = async ({
  baseRef,
  deviceId,
  dirPath,
  mode,
}: GitReviewCacheParams) => {
  if (!dirPath) return;

  const cacheDeviceId = deviceId ?? 'local';
  await Promise.all([
    mutate(deviceKeys.gitReviewPatches(cacheDeviceId, dirPath, mode, baseRef ?? '')),
    mutate(deviceKeys.gitWorkingTreeStatus(cacheDeviceId, dirPath)),
    mutate(deviceKeys.gitAheadBehind(cacheDeviceId, dirPath)),
    mutate(localFileKeys.gitWorkingTreeFiles(deviceId, dirPath)),
  ]);
};

export const useReviewPatches = (
  dirPath: string | undefined,
  mode: ReviewMode,
  baseRef?: string,
  deviceId?: string,
  active = true,
) => {
  const enabled = active && isEnabled(deviceId, dirPath);
  const key = enabled ? getGitReviewPatchesKey({ baseRef, deviceId, dirPath, mode }) : null;

  return useClientDataSWR<ReviewPatchesData>(
    key,
    async () => {
      const data =
        mode === 'branch'
          ? await fetchBranchReviewPatches(dirPath!, baseRef, deviceId)
          : await fetchUnstagedReviewPatches(dirPath!, deviceId);
      // Every live read refreshes the persisted summary the Review tab paints
      // from on the next cold start.
      void mutate(
        getGitReviewSummaryKey({ baseRef, deviceId, dirPath, mode }),
        toReviewPatchesSummary(data),
        { revalidate: false },
      );
      return data;
    },
    {
      focusThrottleInterval: mode === 'branch' ? 30 * 1000 : 5 * 1000,
      refreshInterval: getReviewRefreshInterval(mode, active),
      refreshWhenHidden: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      shouldRetryOnError: false,
    },
  );
};

/**
 * Last persisted review summary (paths + line counts, no diff text) for the
 * same device / directory / mode / base. Cache-only: never fetches; written by
 * `useReviewPatches` after each live read.
 */
export const useReviewPatchesSummary = (
  dirPath: string | undefined,
  mode: ReviewMode,
  baseRef?: string,
  deviceId?: string,
  active = true,
) =>
  useClientDataSWR<ReviewPatchesData>(
    active && isEnabled(deviceId, dirPath)
      ? getGitReviewSummaryKey({ baseRef, deviceId, dirPath, mode })
      : null,
    null,
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );

/**
 * Review data stale-first: the live read when it has landed, otherwise the
 * persisted summary, so a reload lists files immediately instead of spinning.
 * `diffPending` stays true until the live read (with diff text) arrives.
 */
export const useStaleFirstReviewPatches = (
  dirPath: string | undefined,
  mode: ReviewMode,
  baseRef?: string,
  deviceId?: string,
  active = true,
) => {
  const live = useReviewPatches(dirPath, mode, baseRef, deviceId, active);
  const { data: summary } = useReviewPatchesSummary(dirPath, mode, baseRef, deviceId, active);

  return {
    data: live.data ?? summary,
    diffPending: !live.data,
    isLoading: live.isLoading,
    isValidating: live.isValidating,
  };
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
) =>
  useClientDataSWR<GitLinkedPRSummary | undefined>(
    isGithub && branch && isEnabled(deviceId, path)
      ? deviceKeys.gitLinkedPR(deviceId ?? 'local', path, branch)
      : null,
    () => gitService.getLinkedPullRequest({ branch: branch!, deviceId, path: path! }),
    { dedupingInterval: 60 * 1000, focusThrottleInterval: 60 * 1000, shouldRetryOnError: false },
  );

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
) =>
  useClientDataSWR<DeviceGitPullRequestDetailResult | undefined>(
    number !== undefined && isEnabled(deviceId, path)
      ? deviceKeys.gitPullRequestDetail(deviceId ?? 'local', path, number)
      : null,
    () =>
      gitService.getPullRequestDetail({ coreOnly: true, deviceId, number: number!, path: path! }),
    {
      dedupingInterval: 30_000,
      focusThrottleInterval: 60 * 1000,
      refreshInterval: (detail) => pullRequestDetailRefreshInterval(detail, active),
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );

/** Activity starts once core data can paint; its failure never hides the PR. */
export const useFetchGitPullRequestActivity = (
  deviceId: string | undefined,
  path: string | undefined,
  number: number | undefined,
  active = true,
) =>
  useClientDataSWR<DeviceGitPullRequestActivity>(
    number !== undefined && isEnabled(deviceId, path)
      ? deviceKeys.gitPullRequestActivity(deviceId ?? 'local', path, number)
      : null,
    () => gitService.getPullRequestActivity({ deviceId, number: number!, path: path! }),
    {
      dedupingInterval: 30_000,
      focusThrottleInterval: 60_000,
      refreshInterval: active ? 30_000 : 0,
      shouldRetryOnError: false,
    },
  );

/**
 * Slow merge context (permission, branch protection, base drift), keyed on the
 * PR head so a push refetches it. Runs after the detail so the pane paints first.
 */
export const useFetchGitPullRequestMergeContext = (
  deviceId: string | undefined,
  path: string | undefined,
  detail:
    Pick<DeviceGitPullRequestDetail, 'baseRefName' | 'headRefOid' | 'number' | 'repo'> | undefined,
) =>
  useClientDataSWR<DeviceGitPullRequestMergeContext | null | undefined>(
    detail && isEnabled(deviceId, path)
      ? deviceKeys.gitPullRequestMergeContext(
          deviceId ?? 'local',
          path,
          detail.number,
          detail.headRefOid,
          detail.baseRefName,
        )
      : null,
    () =>
      gitService.getPullRequestMergeContext({
        baseRefName: detail!.baseRefName,
        deviceId,
        headRefOid: detail!.headRefOid,
        number: detail!.number,
        path: path!,
        repo: detail!.repo,
      }),
    {
      dedupingInterval: 30_000,
      focusThrottleInterval: 60 * 1000,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );

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
