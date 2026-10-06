'use client';

import { Flexbox, Icon, Markdown } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui/base-ui';
import { GroupBotIcon } from '@lobehub/ui/icons';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronRightIcon, CircleCheckIcon, CircleXIcon, ListTree } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { portalThreadSelectors, threadSelectors } from '@/store/chat/selectors';

import { type MarkdownElementProps } from '../type';
import { parseSubAgentEvent, type SubAgentEventResult } from './parseSubAgentEvent';

const styles = createStaticStyles(({ css, cssVar }) => ({
  mark: css`
    display: inline-flex;
    flex-shrink: 0;
    color: ${cssVar.colorTextDescription};
  `,
  result: css`
    overflow: auto;

    max-block-size: 320px;
    margin-block-start: 6px;
    padding-block: 8px;
    padding-inline: 12px;
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  root: css`
    min-width: 280px;
  `,
  row: css`
    padding-block: 8px;

    &:not(:last-child) {
      border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  rowAction: css`
    height: 22px;
    padding-inline: 6px;
    font-size: 12px;
  `,
  toggle: css`
    cursor: pointer;

    display: flex;
    gap: 4px;
    align-items: center;

    margin-block-start: 4px;
    padding-block: 0;
    padding-inline: 22px 0;
    border: none;

    color: inherit;
    text-align: start;

    background: none;
  `,
  toggleIcon: css`
    flex-shrink: 0;
    color: ${cssVar.colorTextQuaternary};
    transition: transform 0.2s;
  `,
  toggleIconOpen: css`
    transform: rotate(90deg);
  `,
}));

/** One finished sub-agent: its status and label, its answer on demand, a link to its thread. */
const ResultRow = ({ item }: { item: SubAgentEventResult }) => {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);

  const thread = useChatStore((s) =>
    (threadSelectors.currentTopicThreads(s) ?? []).find((candidate) => candidate.id === item.id),
  );
  const openThreadInPortal = useChatStore((s) => s.openThreadInPortal);
  const closeThreadPortal = useChatStore((s) => s.closeThreadPortal);
  const isOpenInPortal = useChatStore(
    (s) => !!thread && portalThreadSelectors.portalThreadId(s) === thread.id,
  );

  const failed = item.status === 'error';
  const name = item.description ?? t('subAgentEvent.untitled');

  return (
    <div className={styles.row}>
      <Flexbox horizontal align={'center'} gap={8}>
        <span className={styles.mark}>
          <GroupBotIcon size={16} />
        </span>
        <Flexbox horizontal align={'center'} flex={1} gap={6} style={{ minWidth: 0 }}>
          <Icon
            color={failed ? cssVar.colorError : cssVar.colorSuccess}
            icon={failed ? CircleXIcon : CircleCheckIcon}
            size={14}
          />
          <Text ellipsis weight={500}>
            {failed
              ? t('subAgentEvent.failedTitle', { name })
              : t('subAgentEvent.completedTitle', { name })}
          </Text>
        </Flexbox>
        {thread && (
          <Button
            className={styles.rowAction}
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
        )}
      </Flexbox>
      <button className={styles.toggle} type={'button'} onClick={() => setOpen(!open)}>
        <Icon
          className={open ? `${styles.toggleIcon} ${styles.toggleIconOpen}` : styles.toggleIcon}
          icon={ChevronRightIcon}
          size={14}
        />
        <Text type={'secondary'}>
          {open ? t('subAgentEvent.hideResult') : t('subAgentEvent.showResult')}
        </Text>
      </button>
      {open && (
        <div className={styles.result}>
          <Markdown variant={'chat'}>{item.result}</Markdown>
        </div>
      )}
    </div>
  );
};

/**
 * Card for the message that hands background sub-agent results back to the
 * agent that started them. The agent reads the full block; the user sees, per
 * finished sub-agent, its name and outcome first, can expand its answer, and
 * can open its thread. The block's instruction is addressed to the agent and
 * is not shown.
 */
const Render = ({ children }: MarkdownElementProps) => {
  const text = typeof children === 'string' ? children : String(children ?? '');
  const results = parseSubAgentEvent(text);

  return (
    <div className={styles.root}>
      {results.map((item) => (
        <ResultRow item={item} key={item.id} />
      ))}
    </div>
  );
};

export default Render;
