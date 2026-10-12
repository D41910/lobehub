import { mutate, useClientDataSWR } from '@/libs/swr';
import { gitService } from '@/services/git';

import {
  getReviewRefreshInterval,
  invalidateGitReviewCaches,
  useReviewPatches,
  useReviewPatchesSummary,
  useStaleFirstReviewPatches,
} from './useReviewPatches';

const platform = vi.hoisted(() => ({ isDesktop: true }));

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal()),
  get isDesktop() {
    return platform.isDesktop;
  },
}));

vi.mock('@/libs/swr', () => ({
  mutate: vi.fn(),
  useClientDataSWR: vi.fn(() => ({ data: undefined })),
}));

vi.mock('@/services/git', () => ({
  gitService: {
    getGitBranchDiff: vi.fn(),
    getGitWorkingTreePatches: vi.fn(),
    listGitRemoteBranches: vi.fn(),
  },
}));

describe('useReviewPatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.isDesktop = true;
  });

  it('polls while the review tab is active and disables polling while hidden', () => {
    expect(getReviewRefreshInterval('unstaged', true)).toBe(10_000);
    expect(getReviewRefreshInterval('branch', true)).toBe(30_000);
    expect(getReviewRefreshInterval('unstaged', false)).toBe(0);

    useReviewPatches('/repo', 'unstaged', undefined, undefined, true);

    expect(useClientDataSWR).toHaveBeenCalledWith(
      ['device:gitReviewPatches', 'local', '/repo', 'unstaged', ''],
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 10_000,
        refreshWhenHidden: false,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
      }),
    );

    vi.clearAllMocks();

    useReviewPatches('/repo', 'branch', 'origin/canary', 'device-1', false);

    expect(useClientDataSWR).toHaveBeenCalledWith(
      null,
      expect.any(Function),
      expect.objectContaining({
        refreshInterval: 0,
      }),
    );
  });

  it('does not request local git patches from a web client without a target device', () => {
    platform.isDesktop = false;

    useReviewPatches('/repo', 'unstaged', undefined, undefined, true);

    expect(useClientDataSWR).toHaveBeenCalledWith(
      null,
      expect.any(Function),
      expect.objectContaining({ refreshInterval: 10_000 }),
    );
  });

  it('invalidates review patches and related git tree status caches together', async () => {
    await invalidateGitReviewCaches({
      baseRef: 'origin/canary',
      deviceId: 'device-1',
      dirPath: '/repo',
      mode: 'branch',
    });

    expect(mutate).toHaveBeenNthCalledWith(1, [
      'device:gitReviewPatches',
      'device-1',
      '/repo',
      'branch',
      'origin/canary',
    ]);
    expect(mutate).toHaveBeenNthCalledWith(2, ['device:gitWorkingTreeStatus', 'device-1', '/repo']);
    expect(mutate).toHaveBeenNthCalledWith(3, ['device:gitAheadBehind', 'device-1', '/repo']);
    expect(mutate).toHaveBeenNthCalledWith(4, [
      'localFile:gitWorkingTreeFiles',
      'device-1',
      '/repo',
    ]);
  });

  // Regression: the Review tab had nothing persisted, so every reload showed a
  // full-panel spinner until the diff read finished. Each live read now writes
  // a path + line-count summary (no diff text) the tab paints from.
  it('writes a diff-free summary of every live read to the persisted summary key', async () => {
    vi.mocked(gitService.getGitWorkingTreePatches).mockResolvedValue({
      patches: [
        {
          additions: 3,
          deletions: 1,
          filePath: 'src/a.ts',
          isBinary: false,
          patch: 'diff --git a/src/a.ts b/src/a.ts\n+big diff text',
          status: 'modified',
          truncated: false,
        },
      ],
      submodules: [
        {
          absolutePath: '/repo/sub',
          name: 'sub',
          patches: [
            {
              additions: 1,
              deletions: 0,
              filePath: 'b.ts',
              isBinary: false,
              patch: '+x',
              status: 'added',
              truncated: false,
            },
          ],
          relativePath: 'sub',
        },
      ],
    } as any);

    useReviewPatches('/repo', 'unstaged', undefined, 'device-1', true);
    const fetcher = vi.mocked(useClientDataSWR).mock.calls[0][1] as () => Promise<unknown>;
    const live = await fetcher();

    expect((live as any).patches[0].patch).toContain('big diff text');
    expect(mutate).toHaveBeenCalledWith(
      ['device:gitReviewSummary', 'device-1', '/repo', 'unstaged', ''],
      {
        baseRef: undefined,
        headRef: undefined,
        mode: 'unstaged',
        patches: [
          {
            additions: 3,
            deletions: 1,
            filePath: 'src/a.ts',
            isBinary: false,
            patch: '',
            status: 'modified',
            truncated: false,
          },
        ],
        submodules: [
          {
            absolutePath: '/repo/sub',
            name: 'sub',
            patches: [
              {
                additions: 1,
                deletions: 0,
                filePath: 'b.ts',
                isBinary: false,
                patch: '',
                status: 'added',
                truncated: false,
              },
            ],
            relativePath: 'sub',
          },
        ],
        summaryOnly: true,
      },
      { revalidate: false },
    );
  });

  it('reads the summary from cache only, under the same scope as the live read', () => {
    useReviewPatchesSummary('/repo', 'branch', 'origin/canary', 'device-1', true);

    expect(useClientDataSWR).toHaveBeenCalledWith(
      ['device:gitReviewSummary', 'device-1', '/repo', 'branch', 'origin/canary'],
      null,
      expect.any(Object),
    );

    vi.clearAllMocks();
    useReviewPatchesSummary('/repo', 'unstaged', undefined, 'device-1', false);

    expect(useClientDataSWR).toHaveBeenCalledWith(null, null, expect.any(Object));
  });

  describe('useStaleFirstReviewPatches', () => {
    const summary = { mode: 'unstaged', patches: [{ filePath: 'src/a.ts' }], summaryOnly: true };
    const live = { mode: 'unstaged', patches: [{ filePath: 'src/live.ts', patch: '+x' }] };
    const mockReads = (liveData: unknown, summaryData: unknown) =>
      vi
        .mocked(useClientDataSWR)
        .mockImplementation(((key: unknown[] | null) =>
          key?.[0] === 'device:gitReviewSummary'
            ? { data: summaryData }
            : { data: liveData, isLoading: liveData === undefined, isValidating: true }) as any);

    // Regression: on every reload the whole Review panel was a spinner until
    // the diff read finished, although the file list was known from last time.
    it('serves the persisted summary while the live diff is still loading', () => {
      mockReads(undefined, summary);

      const result = useStaleFirstReviewPatches('/repo', 'unstaged', undefined, 'device-1');

      expect(result).toEqual({
        data: summary,
        diffPending: true,
        isLoading: true,
        isValidating: true,
      });
    });

    it('prefers the live read once it lands', () => {
      mockReads(live, summary);

      const result = useStaleFirstReviewPatches('/repo', 'unstaged', undefined, 'device-1');

      expect(result.data).toBe(live);
      expect(result.diffPending).toBe(false);
    });

    it('has nothing to show on a first-ever load', () => {
      mockReads(undefined, undefined);

      const result = useStaleFirstReviewPatches('/repo', 'unstaged', undefined, 'device-1');

      expect(result.data).toBeUndefined();
      expect(result.isLoading).toBe(true);
    });
  });
});
