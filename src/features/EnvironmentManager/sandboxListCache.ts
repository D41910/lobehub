import { useClientDataSWR } from '@/libs/swr';
import { sandboxKeys } from '@/libs/swr/keys';
import { sandboxStorageService } from '@/services/sandboxStorage';

import { repositoryPath } from './repository';

type RawEnvironment = Awaited<
  ReturnType<typeof sandboxStorageService.listEnvironments>
>['environments'][number];
type RawInstanceList = Awaited<ReturnType<typeof sandboxStorageService.listInstances>>;
type RawInstance = NonNullable<Awaited<ReturnType<typeof sandboxStorageService.getInstance>>>;

/**
 * What the composer's picker reads of an environment, and nothing more.
 *
 * These lists are persisted to localStorage so the chip names its instance on
 * the first paint after a reload. An environment's configuration is not part
 * of that: it carries `env` and source URLs, and a URL can carry a token, so
 * the checkout is reduced to whether there is one — all the row's icon asks.
 */
export interface SandboxPickerEnvironment {
  /** Whether the environment checks out a git repository. */
  hasRepository: boolean;
  id: string;
  name: string;
  userId: string;
  visibility: RawEnvironment['visibility'];
  workspaceId: string | null;
}

export interface SandboxPickerInstance {
  environmentId: string;
  id: string;
  inUse: boolean;
  inUseByThisTopic: boolean;
  name: string;
  status: RawInstance['status'];
  workingDirectory: string;
}

export interface SandboxPickerInstanceList {
  instances: SandboxPickerInstance[];
}

/** Where a bound instance's files live, which is all the working panel needs. */
export interface SandboxInstanceDirectory {
  id: string;
  workingDirectory: string;
}

export const toPickerEnvironment = (environment: RawEnvironment): SandboxPickerEnvironment => ({
  id: environment.id,
  name: environment.name,
  hasRepository: Boolean(repositoryPath(environment.configuration ?? undefined)),
  userId: environment.userId,
  visibility: environment.visibility,
  workspaceId: environment.workspaceId ?? null,
});

export const toPickerInstanceList = (list: RawInstanceList): SandboxPickerInstanceList => ({
  instances: list.instances.map((instance) => ({
    environmentId: instance.environmentId,
    id: instance.id,
    inUse: instance.inUse,
    inUseByThisTopic: instance.inUseByThisTopic,
    name: instance.name,
    status: instance.status,
    workingDirectory: instance.workingDirectory,
  })),
});

export const toInstanceDirectory = (
  instance: RawInstance | null,
): SandboxInstanceDirectory | null =>
  instance ? { id: instance.id, workingDirectory: instance.workingDirectory } : null;

/** Environments as the composer's picker sees them. */
export const useSandboxPickerEnvironments = (enabled: boolean) =>
  useClientDataSWR<{ environments: SandboxPickerEnvironment[] }>(
    enabled ? sandboxKeys.environments() : null,
    async () => {
      const { environments } = await sandboxStorageService.listEnvironments();
      return { environments: environments.map(toPickerEnvironment) };
    },
  );

/**
 * Instances as the composer's picker sees them, with this topic's occupancy.
 *
 * The topic is in the key because occupancy is answered per conversation —
 * "in use by another one" is a different answer here than there. The instances
 * themselves are the same list either way, so the first send, which takes the
 * topic from none to one, must not blank the chip: it would flash a skeleton
 * for a name that never changed. Kept until the refetch lands; a moment of
 * last-known occupancy is not worth that.
 */
export const useSandboxPickerInstances = (enabled: boolean, topicId?: string) =>
  useClientDataSWR<SandboxPickerInstanceList>(
    enabled ? sandboxKeys.instances(topicId) : null,
    async () =>
      toPickerInstanceList(
        await sandboxStorageService.listInstances({ topicId, withSizes: false }),
      ),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

/** The bound instance's directory; `null` once the instance is known to be gone. */
export const useSandboxInstanceDirectory = (instanceId?: string) =>
  useClientDataSWR<SandboxInstanceDirectory | null>(
    instanceId ? sandboxKeys.instanceDir(instanceId) : null,
    async () => toInstanceDirectory(await sandboxStorageService.getInstance({ id: instanceId! })),
  );
