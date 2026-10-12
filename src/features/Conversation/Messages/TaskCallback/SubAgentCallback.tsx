'use client';

import { Markdown } from '@lobehub/ui';
import { Button, Tag } from '@lobehub/ui/base-ui';
import { ListTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ChatItem } from '@/features/Conversation/ChatItem';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useChatStore } from '@/store/chat';
import { portalThreadSelectors, threadSelectors } from '@/store/chat/selectors';

interface SubAgentCallbackMessageProps {
  /** Who answered — `metadata.subAgentCallback`. */
  callback: { agentId?: string; name: string; status: 'completed' | 'error'; threadId: string };
  content: string;
  createdAt?: number;
  id: string;
}

/**
 * A background sub-agent's answer, shown as a message from that sub-agent: its
 * avatar and name, the answer itself as the content, and a link to its thread.
 */
const SubAgentCallbackMessage = ({
  callback,
  content,
  createdAt,
  id,
}: SubAgentCallbackMessageProps) => {
  const { t } = useTranslation('chat');
  const meta = useAgentStore(agentSelectors.getAgentMetaById(callback.agentId ?? ''));

  const thread = useChatStore((s) =>
    (threadSelectors.currentTopicThreads(s) ?? []).find(
      (candidate) => candidate.id === callback.threadId,
    ),
  );
  const openThreadInPortal = useChatStore((s) => s.openThreadInPortal);
  const closeThreadPortal = useChatStore((s) => s.closeThreadPortal);
  const isOpenInPortal = useChatStore(
    (s) => !!thread && portalThreadSelectors.portalThreadId(s) === thread.id,
  );

  const failed = callback.status === 'error';

  return (
    <ChatItem
      avatar={{ ...meta, title: callback.name || meta.title }}
      id={id}
      placement={'left'}
      time={createdAt}
      actionAddon={
        thread ? (
          <Button
            icon={ListTree}
            size={'small'}
            type={'text'}
            onClick={() =>
              isOpenInPortal
                ? closeThreadPortal()
                : openThreadInPortal(thread.id, thread.sourceMessageId)
            }
          >
            {isOpenInPortal ? t('thread.closeSubagentThread') : t('thread.openSubagentThread')}
          </Button>
        ) : undefined
      }
      titleAddon={
        <>
          <Tag size={'small'}>{t('subAgentCallback.tag')}</Tag>
          {failed && (
            <Tag color={'error'} size={'small'}>
              {t('subAgentCallback.failed')}
            </Tag>
          )}
        </>
      }
    >
      <Markdown variant={'chat'}>{content}</Markdown>
    </ChatItem>
  );
};

export default SubAgentCallbackMessage;
