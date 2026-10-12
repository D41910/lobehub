import type { DeviceListItem, WorkingDirEntry } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_LIST_SWR_KEY } from '@/features/DeviceManager/const';
import { cacheScope } from '@/libs/replica';
import { mutate } from '@/libs/swr';
import { deviceService } from '@/services/device';

import { initialState } from './initialState';
import { DEVICE_LIST_KEY } from './projection';
import { deviceSelectors } from './selectors';
import { useDeviceStore } from './store';

vi.mock('@/libs/swr', () => ({
  mutate: vi.fn(),
  useClientDataSWR: vi.fn(),
}));

const seedDevices = (devices: DeviceListItem[]) =>
  useDeviceStore.setState({ deviceListMap: { [DEVICE_LIST_KEY]: devices } });

/** The SWR matchers the action revalidated with. */
const revalidatedMatchers = () =>
  vi
    .mocked(mutate)
    .mock.calls.map(([key]) => key)
    .filter((key): key is (key: unknown) => boolean => typeof key === 'function');

const revalidatedDeviceListReplica = () =>
  revalidatedMatchers().some((matcher) =>
    matcher(['replica:sync', 'deviceList', 1, cacheScope.get(), DEVICE_LIST_KEY, {}]),
  );

const buildDevice = (overrides: Partial<DeviceListItem> = {}): DeviceListItem => ({
  channels: [],
  defaultCwd: '/repo',
  deviceId: 'dev-1',
  enroller: null,
  friendlyName: null,
  hostname: null,
  identitySource: 'machine-id',
  lastSeen: new Date(0).toISOString(),
  online: false,
  platform: null,
  registered: true,
  scope: 'personal',
  visibility: null,
  workingDirs: [],
  ...overrides,
});

describe('DeviceAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mutate).mockResolvedValue(undefined);
    vi.spyOn(deviceService, 'updateDevice').mockResolvedValue({ success: true });
    useDeviceStore.setState(initialState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('clearDeviceDefaultCwd', () => {
    it('clears the device default without removing it from recent directories', async () => {
      const workingDirs: WorkingDirEntry[] = [
        { path: '/repo', repoType: 'git' },
        { path: '/other' },
      ];
      const otherDevice = buildDevice({
        defaultCwd: '/other-device',
        deviceId: 'dev-2',
        workingDirs: [{ path: '/other-device' }],
      });
      seedDevices([buildDevice({ workingDirs }), otherDevice]);

      await useDeviceStore.getState().clearDeviceDefaultCwd('dev-1');

      const state = useDeviceStore.getState();
      expect(deviceSelectors.getDeviceDefaultCwd('dev-1')(state)).toBeUndefined();
      expect(deviceSelectors.getDeviceWorkingDirs('dev-1')(state)).toEqual(workingDirs);
      expect(deviceSelectors.getDeviceById('dev-2')(state)).toEqual(otherDevice);
      expect(deviceService.updateDevice).toHaveBeenCalledWith({
        defaultCwd: null,
        deviceId: 'dev-1',
      });
      expect(revalidatedDeviceListReplica()).toBe(true);
    });

    // Task controls read the workspace-scoped `useDeviceList` entry, so a cwd
    // write that only revalidated this store's key left them showing stale recents.
    it('also revalidates the canonical device-list cache', async () => {
      seedDevices([buildDevice()]);

      await useDeviceStore.getState().clearDeviceDefaultCwd('dev-1');

      const matchers = revalidatedMatchers();
      expect(matchers.some((matcher) => matcher([DEVICE_LIST_SWR_KEY, 'ws-1']))).toBe(true);
      expect(revalidatedDeviceListReplica()).toBe(true);
    });

    it('does nothing when the target device does not exist', async () => {
      seedDevices([buildDevice()]);

      await useDeviceStore.getState().clearDeviceDefaultCwd('missing');

      expect(deviceService.updateDevice).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    });

    it('restores the previous default and revalidates when persistence fails', async () => {
      const workingDirs: WorkingDirEntry[] = [{ path: '/repo', repoType: 'git' }];
      seedDevices([buildDevice({ workingDirs })]);
      vi.mocked(deviceService.updateDevice).mockRejectedValueOnce(new Error('save failed'));

      await expect(useDeviceStore.getState().clearDeviceDefaultCwd('dev-1')).rejects.toThrow(
        'save failed',
      );

      const state = useDeviceStore.getState();
      expect(deviceSelectors.getDeviceDefaultCwd('dev-1')(state)).toBe('/repo');
      expect(deviceSelectors.getDeviceWorkingDirs('dev-1')(state)).toEqual(workingDirs);
      expect(revalidatedDeviceListReplica()).toBe(true);
    });
  });
});
