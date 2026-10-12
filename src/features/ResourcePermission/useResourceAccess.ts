import { useHasActiveWorkspace } from '@/business/client/hooks/useHasActiveWorkspace';
import { useClientDataSWR } from '@/libs/swr';
import { resourcePermissionKeys } from '@/libs/swr/keys';
import type { PermissionResourceType } from '@/services/resourcePermission';
import { resourcePermissionService } from '@/services/resourcePermission';

/**
 * Read-side derivation of the workspace General-access level for a resource.
 *
 * Edit/use checks stay permissive while workspace access is loading so chat
 * input does not flash disabled. A server-confirmed creator/admin (`canManage`)
 * bypasses the public resource's Member Permissions. Management checks are
 * deliberately fail-closed: destructive/ownership controls must not appear
 * until that access is confirmed. Personal mode keeps full access.
 *
 * The access record is persisted (local cache tier), so after a reload every
 * check resolves from the last server-confirmed value while it revalidates.
 * `isAccessConfirmed` is only true once the current session has re-fetched it —
 * use it before acting on a denial (redirects), never to delay rendering.
 */
export const useResourceAccess = (
  resourceType: PermissionResourceType,
  resourceId: string | undefined,
) => {
  const hasActiveWorkspace = useHasActiveWorkspace();
  const enabled = hasActiveWorkspace && !!resourceId;

  const { data, error, isLoading, isValidating, mutate } = useClientDataSWR(
    enabled ? resourcePermissionKeys.generalAccess(resourceType, resourceId!) : null,
    () => resourcePermissionService.getGeneralAccess(resourceType, resourceId!),
  );

  return {
    accessError: error,
    canEditResource: !enabled || !data ? true : data.canManage || data.accessLevel === 'edit',
    canManageResource: !enabled || data?.canManage === true,
    canUseResource: !enabled || !data ? true : data.canManage || data.accessLevel !== 'view',
    isAccessConfirmed: !enabled || (!!data && !isValidating && !error),
    isAccessResolved: !enabled || !!data,
    isLoading,
    retryAccess: mutate,
  };
};
