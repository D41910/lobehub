import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRE_PAINT_HYDRATE_TIMEOUT } from '@/libs/replica/prePaint';

import {
  agentChatTopicListLoader,
  preHydrateMessagesForRoute,
  preHydrateTopicListForRoute,
} from './topicListLoader';

const preHydrateTopicListMock = vi.hoisted(() => vi.fn(async () => true));
const getSidebarTopicListParamsMock = vi.hoisted(() => vi.fn());
const readPersistedTranscriptMock = vi.hoisted(() => vi.fn());
const chatState = vi.hoisted(() => ({
  dbMessagesMap: {} as Record<string, unknown[]>,
  replaceMessages: vi.fn(),
}));
const builtinAgentIdMap = vi.hoisted(() => ({ inbox: 'agt_inbox' }) as Record<string, string>);
const preHydrateBuiltinAgentMock = vi.hoisted(() => vi.fn(async () => true));
const preHydrateVerifyRunsMock = vi.hoisted(() => vi.fn(async (_ids: string[]) => {}));

vi.mock('@lobechat/builtin-agents', () => ({
  BUILTIN_AGENT_SLUGS: { inbox: 'inbox' },
}));

vi.mock('@/hooks/chatTopicListQuery', () => ({
  getSidebarTopicListParams: getSidebarTopicListParamsMock,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: {
    getState: () => ({ builtinAgentIdMap, preHydrateBuiltinAgent: preHydrateBuiltinAgentMock }),
  },
}));

vi.mock('@/store/agent/selectors', () => ({
  builtinAgentSelectors: {
    getBuiltinAgentId: (slug: string) => (state: { builtinAgentIdMap: Record<string, string> }) =>
      state.builtinAgentIdMap[slug],
  },
}));

vi.mock('@/store/chat', () => ({
  useChatStore: {
    getState: () => ({ ...chatState, preHydrateTopicList: preHydrateTopicListMock }),
  },
}));

vi.mock('@/store/verify', () => ({
  useVerifyStore: { getState: () => ({ preHydrateVerifyRuns: preHydrateVerifyRunsMock }) },
}));

vi.mock('@/services/message/replica', () => ({
  readPersistedTranscript: readPersistedTranscriptMock,
}));

const loaderArgs = (aid?: string) => ({ params: aid ? { aid } : {} }) as never;

describe('agent chat topic list loader', () => {
  beforeEach(() => {
    preHydrateTopicListMock.mockClear();
    preHydrateTopicListMock.mockResolvedValue(true);
    preHydrateBuiltinAgentMock.mockClear();
    preHydrateBuiltinAgentMock.mockResolvedValue(true);
    getSidebarTopicListParamsMock.mockReset();
    getSidebarTopicListParamsMock.mockReturnValue({ agentId: 'agt_1', pageSize: 20 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the persisted page for the route agent before the route commits', async () => {
    getSidebarTopicListParamsMock.mockReturnValue({ agentId: 'agt_1', pageSize: 20 });

    await expect(agentChatTopicListLoader(loaderArgs('agt_1'))).resolves.toBeNull();

    expect(getSidebarTopicListParamsMock).toHaveBeenCalledWith({ agentId: 'agt_1' });
    expect(preHydrateTopicListMock).toHaveBeenCalledWith({ agentId: 'agt_1', pageSize: 20 });
  });

  it('pre-hydrates the persisted builtin before resolving a builtin slug', async () => {
    await expect(agentChatTopicListLoader(loaderArgs('inbox'))).resolves.toBeNull();

    expect(preHydrateBuiltinAgentMock).toHaveBeenCalledWith('inbox');
    expect(getSidebarTopicListParamsMock).toHaveBeenCalledWith({ agentId: 'agt_inbox' });
  });

  it('does not pre-hydrate a builtin for a concrete agent id', async () => {
    await agentChatTopicListLoader(loaderArgs('agt_1'));

    expect(preHydrateBuiltinAgentMock).not.toHaveBeenCalled();
  });

  it('resolves a builtin slug to its agent id', async () => {
    await preHydrateTopicListForRoute('inbox');

    expect(getSidebarTopicListParamsMock).toHaveBeenCalledWith({ agentId: 'agt_inbox' });
  });

  it('skips entirely when the route names no agent', async () => {
    await expect(agentChatTopicListLoader(loaderArgs())).resolves.toBeNull();

    expect(getSidebarTopicListParamsMock).not.toHaveBeenCalled();
    expect(preHydrateTopicListMock).not.toHaveBeenCalled();
  });

  it('does not block the route when the hydrate never resolves', async () => {
    vi.useFakeTimers();
    preHydrateTopicListMock.mockImplementation(() => new Promise(() => {}));

    const pending = agentChatTopicListLoader(loaderArgs('agt_1'));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(PRE_PAINT_HYDRATE_TIMEOUT - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });

  it('never rejects the route when the hydrate fails', async () => {
    preHydrateTopicListMock.mockRejectedValue(new Error('storage exploded'));

    await expect(agentChatTopicListLoader(loaderArgs('agt_1'))).resolves.toBeNull();
  });
});

describe('agent chat transcript pre-hydrate', () => {
  const rows = [{ content: 'hi', id: 'msg_1', role: 'user' }];

  beforeEach(() => {
    chatState.dbMessagesMap = {};
    chatState.replaceMessages.mockClear();
    preHydrateVerifyRunsMock.mockReset();
    readPersistedTranscriptMock.mockReset();
    readPersistedTranscriptMock.mockResolvedValue({ items: rows });
  });

  it("seeds the topic's persisted transcript into the chat store before the route commits", async () => {
    await agentChatTopicListLoader({ params: { aid: 'agt_1', topicId: 'tpc_1' } } as never);

    const context = { agentId: 'agt_1', scope: 'main', topicId: 'tpc_1' };
    expect(readPersistedTranscriptMock).toHaveBeenCalledWith(context);
    expect(chatState.replaceMessages).toHaveBeenCalledWith(rows, {
      action: 'preHydrateMessages',
      context,
      source: 'fetch',
    });
  });

  it('seeds the verify cards of the transcript before its messages land', async () => {
    const order: string[] = [];
    preHydrateVerifyRunsMock.mockImplementation(async () => {
      order.push('verify');
    });
    chatState.replaceMessages.mockImplementation(() => order.push('messages'));
    readPersistedTranscriptMock.mockResolvedValue({
      items: [
        ...rows,
        { id: 'msg_2', metadata: { verifyOperationId: 'op_1' }, role: 'verify' },
        { id: 'msg_3', metadata: {}, role: 'verify' },
      ],
    });

    await preHydrateMessagesForRoute('agt_1', 'tpc_1');

    expect(preHydrateVerifyRunsMock).toHaveBeenCalledWith(['op_1']);
    expect(order).toEqual(['verify', 'messages']);
    chatState.replaceMessages.mockReset();
  });

  it('still seeds the transcript when the verify cards cannot be read', async () => {
    preHydrateVerifyRunsMock.mockRejectedValue(new Error('storage exploded'));

    await preHydrateMessagesForRoute('agt_1', 'tpc_1');

    expect(chatState.replaceMessages).toHaveBeenCalled();
  });

  it('never replaces rows the chat store already holds', async () => {
    chatState.dbMessagesMap = { main_agt_1_tpc_1: [] };

    await preHydrateMessagesForRoute('agt_1', 'tpc_1');

    expect(chatState.replaceMessages).not.toHaveBeenCalled();
  });

  it('skips a route without a topic and a miss in storage', async () => {
    await preHydrateMessagesForRoute('agt_1');
    expect(readPersistedTranscriptMock).not.toHaveBeenCalled();

    readPersistedTranscriptMock.mockResolvedValue(undefined);
    await preHydrateMessagesForRoute('agt_1', 'tpc_1');
    expect(chatState.replaceMessages).not.toHaveBeenCalled();
  });
});
