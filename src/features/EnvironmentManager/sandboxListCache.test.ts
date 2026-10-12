/**
 * @vitest-environment happy-dom
 */
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { type Cache, SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CACHE_TIERS,
  createCacheProvider,
  getScopedCacheKey,
} from '@/libs/swr/localStorageProvider';
import { sandboxStorageService } from '@/services/sandboxStorage';

import {
  useSandboxInstanceDirectory,
  useSandboxPickerEnvironments,
  useSandboxPickerInstances,
} from './sandboxListCache';

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => 'ws-1',
}));

vi.mock('@/services/sandboxStorage', () => ({
  sandboxStorageService: {
    getInstance: vi.fn(),
    listEnvironments: vi.fn(),
    listInstances: vi.fn(),
  },
}));

const SCOPE = 'sandbox-cache-user:ws-1';

const environment = {
  configuration: {
    env: { API_TOKEN: 'secret-value' },
    sources: [
      { kind: 'git', url: 'https://x-access-token:ghp_secret@github.com/lobehub/lobehub.git' },
    ],
  },
  createdAt: new Date('2026-10-01'),
  creator: null,
  description: null,
  id: 'env-1',
  name: 'Lobehub Dev',
  updatedAt: new Date('2026-10-01'),
  userId: 'user-1',
  visibility: 'private',
  workspaceId: 'ws-1',
};

const instance = {
  buildError: 'npm ERR! token=secret-in-log',
  buildId: null,
  buildable: true,
  createdAt: new Date('2026-10-01'),
  environmentId: 'env-1',
  id: 'inst-1',
  inUse: false,
  inUseByThisTopic: false,
  name: 'main checkout',
  snapshot: null,
  status: 'ready',
  workingDirectory: 'lobehub',
};

const makeProvider = () =>
  createCacheProvider({
    debounceMs: 5,
    getScope: () => SCOPE,
    idbPatterns: [],
    localPatterns: [...CACHE_TIERS.local],
  });

const wrapper =
  (provider: ReturnType<typeof createCacheProvider>) =>
  ({ children }: PropsWithChildren) =>
    createElement(
      SWRConfig,
      { value: { provider: provider as unknown as (c: Readonly<Cache>) => Cache } },
      children,
    );

const useAll = () => ({
  directory: useSandboxInstanceDirectory('inst-1'),
  environments: useSandboxPickerEnvironments(true),
  instances: useSandboxPickerInstances(true, 'topic-1'),
});

describe('sandbox list cache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(sandboxStorageService.listEnvironments).mockResolvedValue({
      environments: [environment],
    } as any);
    vi.mocked(sandboxStorageService.listInstances).mockResolvedValue({
      instances: [instance],
      occupancyUnavailable: false,
      snapshotsUnavailable: false,
    } as any);
    vi.mocked(sandboxStorageService.getInstance).mockResolvedValue({
      ...instance,
      configurationSnapshot: environment.configuration,
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Regression: the instance directory, the picker's instances and its
  // environments were memory-only, so after every reload the Files tab and the
  // composer's instance chip waited on a round trip before they could appear.
  it('serves the last instances, environments and directory on the first render after a reload', async () => {
    const first = renderHook(useAll, { wrapper: wrapper(makeProvider()) });
    await waitFor(() => {
      expect(first.result.current.directory.data).toBeTruthy();
      expect(first.result.current.environments.data).toBeTruthy();
      expect(first.result.current.instances.data).toBeTruthy();
    });
    await waitFor(() => {
      const stored = localStorage.getItem(getScopedCacheKey(SCOPE)) ?? '';
      expect(stored).toContain('sandbox:instanceDir');
      expect(stored).toContain('sandbox:instances');
      expect(stored).toContain('sandbox:environments');
    });
    first.unmount();

    // "Reload": a fresh provider over the same localStorage, with a network
    // that never answers — whatever renders came from the persisted tier.
    const never = () => new Promise<never>(() => {});
    vi.mocked(sandboxStorageService.listEnvironments).mockImplementation(never);
    vi.mocked(sandboxStorageService.listInstances).mockImplementation(never);
    vi.mocked(sandboxStorageService.getInstance).mockImplementation(never);

    const second = renderHook(useAll, { wrapper: wrapper(makeProvider()) });

    expect(second.result.current.directory.data).toEqual({
      id: 'inst-1',
      workingDirectory: 'lobehub',
    });
    expect(second.result.current.directory.isLoading).toBe(false);
    expect(second.result.current.instances.data?.instances[0]?.name).toBe('main checkout');
    expect(second.result.current.instances.isLoading).toBe(false);
    expect(second.result.current.environments.data?.environments[0]).toMatchObject({
      id: 'env-1',
      name: 'Lobehub Dev',
      hasRepository: true,
    });
    expect(second.result.current.environments.isLoading).toBe(false);
  });

  it('never persists environment configuration, source URLs or build logs', async () => {
    const view = renderHook(useAll, { wrapper: wrapper(makeProvider()) });
    await waitFor(() => {
      const stored = localStorage.getItem(getScopedCacheKey(SCOPE)) ?? '';
      expect(stored).toContain('sandbox:environments');
      expect(stored).toContain('sandbox:instanceDir');
      expect(stored).toContain('sandbox:instances');
    });
    view.unmount();

    const stored = localStorage.getItem(getScopedCacheKey(SCOPE)) ?? '';
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('configuration');
    expect(stored).not.toContain('API_TOKEN');
    expect(stored).not.toContain('buildError');
  });
});
