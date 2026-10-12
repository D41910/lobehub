'use client';

import { toast } from '@lobehub/ui/base-ui';
import { memo, type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import SurfaceSkeleton from '@/components/Skeleton/Surface';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { usePermission } from '@/hooks/usePermission';

import { useResourceAccess } from './useResourceAccess';

interface ResourceConfigAccessGateProps {
  children: ReactNode;
  loading?: ReactNode;
  redirectPath: string;
  requiredAccess?: 'edit' | 'manage';
  resourceId?: string;
  resourceType: 'agent' | 'agentGroup';
}

const ResourceConfigAccessGate = memo<ResourceConfigAccessGateProps>(
  ({ children, loading, redirectPath, requiredAccess = 'edit', resourceId, resourceType }) => {
    const { t } = useTranslation('chat');
    const navigate = useWorkspaceAwareNavigate();
    const hasRedirected = useRef(false);
    const { allowed: canEditContent } = usePermission('edit_own_content');
    const {
      accessError,
      canEditResource,
      canManageResource,
      isAccessConfirmed,
      isAccessResolved,
      retryAccess,
    } = useResourceAccess(resourceType, resourceId);

    // Stale-first: a cached grant renders the config page immediately while the
    // access record revalidates (the server still checks every write). A
    // denial only redirects once this session has re-confirmed it, so an
    // outdated cached denial cannot bounce a user who was just granted access.
    const accessReady = !!resourceId && isAccessResolved;
    const canConfigure =
      accessReady &&
      canEditContent &&
      (requiredAccess === 'manage' ? canManageResource : canEditResource);
    const denialConfirmed = accessReady && isAccessConfirmed && !canConfigure;

    useEffect(() => {
      if (!denialConfirmed || accessError || hasRedirected.current) return;

      hasRedirected.current = true;
      // Name the actual reason: a workspace role that cannot configure Agents at
      // all reads very differently from holding use-only access on this one
      // resource, and conflating them made authors think their own Agent had
      // rejected them.
      const isRoleRestricted = !canEditContent;
      const isManagementRestricted =
        requiredAccess === 'manage' && canEditResource && !canManageResource;
      const messageKey =
        resourceType === 'agent'
          ? isRoleRestricted
            ? 'permission.configAccess.agentRoleRestricted'
            : isManagementRestricted
              ? 'permission.configAccess.agentManageRestricted'
              : 'permission.configAccess.agentChatOnly'
          : isRoleRestricted
            ? 'permission.configAccess.groupRoleRestricted'
            : 'permission.configAccess.groupChatOnly';
      toast.info(t(messageKey));
      navigate(redirectPath, { replace: true });
    }, [
      accessError,
      canEditContent,
      canEditResource,
      canManageResource,
      denialConfirmed,
      navigate,
      redirectPath,
      requiredAccess,
      resourceType,
      t,
    ]);

    return (
      <AsyncBoundary
        data={accessReady ? true : undefined}
        error={accessError}
        errorVariant={'page'}
        isLoading={!accessReady && !accessError}
        loading={loading ?? <SurfaceSkeleton variant={'form'} />}
        onRetry={() => void retryAccess()}
      >
        {canConfigure ? children : (loading ?? <SurfaceSkeleton variant={'form'} />)}
      </AsyncBoundary>
    );
  },
);

ResourceConfigAccessGate.displayName = 'ResourceConfigAccessGate';

export default ResourceConfigAccessGate;
