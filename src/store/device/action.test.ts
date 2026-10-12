import type { DeviceListItem, WorkingDirEntry } from '@lobechat/types';
import { renderHook } from '@testing-library/react';
import type { SWRResponse } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_LIST_SWR_KEY } from '@/features/DeviceManager/const';
import { mutate, useClientDataSWR } from '@/libs/swr';
import { deviceKeys } from '@/libs/swr/keys';
import { deviceService } from '@/services/device';

import { deviceSelectors } from './selectors';
import { useDeviceStore } from './store';

vi.mock('@/libs/swr', () => ({
  mutate: vi.fn(),
  useClientDataSWR: vi.fn(),
}));

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
    useDeviceStore.setState({ devices: [], isDevicesInit: true });
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
      useDeviceStore.setState({
        devices: [buildDevice({ workingDirs }), otherDevice],
      });

      await useDeviceStore.getState().clearDeviceDefaultCwd('dev-1');

      const state = useDeviceStore.getState();
      expect(deviceSelectors.getDeviceDefaultCwd('dev-1')(state)).toBeUndefined();
      expect(deviceSelectors.getDeviceWorkingDirs('dev-1')(state)).toEqual(workingDirs);
      expect(state.devices.find((device) => device.deviceId === 'dev-2')).toEqual(otherDevice);
      expect(deviceService.updateDevice).toHaveBeenCalledWith({
        defaultCwd: null,
        deviceId: 'dev-1',
      });
      expect(mutate).toHaveBeenCalledWith(deviceKeys.listDevices());
    });

    // Task controls read the workspace-scoped `useDeviceList` entry, so a cwd
    // write that only revalidated this store's key left them showing stale recents.
    it('also revalidates the canonical device-list cache', async () => {
      useDeviceStore.setState({ devices: [buildDevice()] });

      await useDeviceStore.getState().clearDeviceDefaultCwd('dev-1');

      const matcher = vi
        .mocked(mutate)
        .mock.calls.map(([key]) => key)
        .find((key): key is (key: unknown) => boolean => typeof key === 'function');
      expect(matcher?.([DEVICE_LIST_SWR_KEY, 'ws-1'])).toBe(true);
      expect(matcher?.(deviceKeys.listDevices())).toBe(false);
    });

    it('does nothing when the target device does not exist', async () => {
      useDeviceStore.setState({ devices: [buildDevice()] });

      await useDeviceStore.getState().clearDeviceDefaultCwd('missing');

      expect(deviceService.updateDevice).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    });

    it('restores the previous default and revalidates when persistence fails', async () => {
      const workingDirs: WorkingDirEntry[] = [{ path: '/repo', repoType: 'git' }];
      useDeviceStore.setState({ devices: [buildDevice({ workingDirs })] });
      vi.mocked(deviceService.updateDevice).mockRejectedValueOnce(new Error('save failed'));

      await expect(useDeviceStore.getState().clearDeviceDefaultCwd('dev-1')).rejects.toThrow(
        'save failed',
      );

      const state = useDeviceStore.getState();
      expect(deviceSelectors.getDeviceDefaultCwd('dev-1')(state)).toBe('/repo');
      expect(deviceSelectors.getDeviceWorkingDirs('dev-1')(state)).toEqual(workingDirs);
      expect(mutate).toHaveBeenCalledWith(deviceKeys.listDevices());
    });
  });

  // Regression: the store only filled `devices` in `onSuccess`, so after a
  // reload a persisted device list sat unused until the fetch returned — the
  // device default cwd resolved late and the chip named the device "Unknown".
  describe('useFetchDevices', () => {
    const cached = [buildDevice({ defaultCwd: '/cached', onlineUnknown: true })];
    const mockSWR = (data: DeviceListItem[]) =>
      vi.mocked(useClientDataSWR).mockReturnValue({ data } as SWRResponse<DeviceListItem[]>);

    it('seeds the store from the cached list before the fetch confirms it', () => {
      useDeviceStore.setState({ devices: [], isDevicesInit: false });
      mockSWR(cached);

      renderHook(() => useDeviceStore.getState().useFetchDevices(true));

      const state = useDeviceStore.getState();
      expect(deviceSelectors.getDeviceDefaultCwd('dev-1')(state)).toBe('/cached');
      // Only the server fetch may mark the list as confirmed.
      expect(state.isDevicesInit).toBe(false);
    });

    it('never overwrites a list the server already confirmed', () => {
      const confirmed = [buildDevice({ defaultCwd: '/fresh', online: true })];
      useDeviceStore.setState({ devices: confirmed, isDevicesInit: true });
      mockSWR(cached);

      renderHook(() => useDeviceStore.getState().useFetchDevices(true));

      expect(useDeviceStore.getState().devices).toBe(confirmed);
    });

    it('does not seed while disabled', () => {
      useDeviceStore.setState({ devices: [], isDevicesInit: false });
      mockSWR(cached);

      renderHook(() => useDeviceStore.getState().useFetchDevices(false));

      expect(useDeviceStore.getState().devices).toEqual([]);
    });
  });
});
