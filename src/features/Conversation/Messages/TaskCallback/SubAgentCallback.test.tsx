/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import SubAgentCallbackMessage from './SubAgentCallback';

// Render the header the way the real ChatItem does: the sender name and the
// title addon only exist when `showTitle` is set.
vi.mock('@/features/Conversation/ChatItem', () => ({
  ChatItem: ({
    avatar,
    children,
    showTitle,
    titleAddon,
  }: {
    avatar: { title?: string };
    children: ReactNode;
    showTitle?: boolean;
    titleAddon?: ReactNode;
  }) => (
    <div>
      {showTitle && <span data-testid="sender">{avatar.title}</span>}
      {showTitle && titleAddon}
      {children}
    </div>
  ),
}));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) => selector({ agentMap: {} }),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ closeThreadPortal: vi.fn(), openThreadInPortal: vi.fn() }),
}));

vi.mock('@/store/chat/selectors', () => ({
  portalThreadSelectors: { portalThreadId: () => undefined },
  threadSelectors: { currentTopicThreads: () => [] },
}));

describe('SubAgentCallbackMessage', () => {
  // Reviewers read the answer as coming from the sub-agent, so the header must
  // name it — an avatar alone does not say which sub-agent spoke.
  it('names the sub-agent as the sender and shows its answer as the content', () => {
    render(
      <SubAgentCallbackMessage
        callback={{ name: '列 todo 并写雪诗', status: 'completed', threadId: 'thd_1' }}
        content="四行雪诗"
        id="subagent-cb-1"
      />,
    );

    expect(screen.getByTestId('sender').textContent).toBe('列 todo 并写雪诗');
    expect(screen.getByText('subAgentCallback.tag')).toBeTruthy();
    expect(screen.getByText('四行雪诗')).toBeTruthy();
    expect(screen.queryByText('subAgentCallback.failed')).toBeNull();
  });

  it('marks a sub-agent that did not finish', () => {
    render(
      <SubAgentCallbackMessage
        callback={{ name: 'Research', status: 'error', threadId: 'thd_2' }}
        content="Budget exceeded"
        id="subagent-cb-2"
      />,
    );

    expect(screen.getByText('subAgentCallback.failed')).toBeTruthy();
  });
});
