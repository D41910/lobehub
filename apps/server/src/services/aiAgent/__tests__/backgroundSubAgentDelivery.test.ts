import { SUB_AGENT_EVENT_TAG } from '@lobechat/const';
import { RequestTrigger } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BackgroundSubAgentDeliveryDeps,
  buildSubAgentEventPrompt,
  deliverBackgroundSubAgentResults,
} from '../backgroundSubAgentDelivery';

const finished = (
  id: string,
  overrides: {
    agentId?: string | null;
    description?: string;
    state?: object;
    threadId?: string;
  } = {},
) => ({
  agentId: overrides.agentId === undefined ? 'agent-1' : overrides.agentId,
  arguments: JSON.stringify({ description: overrides.description ?? `Task ${id}` }),
  id,
  state: {
    background: true,
    result: `Answer of ${id}`,
    status: 'completed',
    threadId: `thread-${id}`,
    ...overrides.state,
  },
  threadId: overrides.threadId ?? null,
});

const createDeps = (opts: {
  marker?: { operationId: string } | null;
  markerStatus?: string;
  pending?: ReturnType<typeof finished>[];
}) => {
  const deps = {
    agentOperationModel: {
      findById: vi.fn().mockResolvedValue(opts.markerStatus ? { status: opts.markerStatus } : null),
    },
    execAgent: vi.fn().mockResolvedValue({ operationId: 'wake-op', success: true }),
    messageModel: {
      claimBackgroundSubAgentDelivery: vi.fn(async (ids: string[]) => ids),
      listBackgroundSubAgentCalls: vi.fn().mockResolvedValue(opts.pending ?? []),
      releaseBackgroundSubAgentDelivery: vi.fn().mockResolvedValue(undefined),
    },
    topicModel: {
      findById: vi.fn().mockResolvedValue({
        agentId: 'agent-1',
        id: 'topic-1',
        metadata: { runningOperation: opts.marker ?? null },
      }),
    },
  };
  return deps as typeof deps & BackgroundSubAgentDeliveryDeps;
};

describe('deliverBackgroundSubAgentResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wakes the parent with every finished result of its branch in one turn', async () => {
    const deps = createDeps({ pending: [finished('a'), finished('b')] });

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    expect(deps.messageModel.claimBackgroundSubAgentDelivery).toHaveBeenCalledWith(
      ['a', 'b'],
      expect.any(String),
    );
    expect(deps.execAgent).toHaveBeenCalledTimes(1);
    const params = deps.execAgent.mock.calls[0][0];
    expect(params).toMatchObject({
      agentId: 'agent-1',
      appContext: { threadId: null, topicId: 'topic-1' },
      autoStart: true,
      externalOrigin: { kind: 'sub_agent_results', label: 'Task a, Task b', provider: 'lobehub' },
      trigger: RequestTrigger.Chat,
    });
    expect(params.prompt).toContain('id="thread-a"');
    expect(params.prompt).toContain('Answer of b');
  });

  it('waits while another run holds the topic', async () => {
    const deps = createDeps({
      marker: { operationId: 'user-op' },
      markerStatus: 'running',
      pending: [finished('a')],
    });

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    expect(deps.messageModel.listBackgroundSubAgentCalls).not.toHaveBeenCalled();
    expect(deps.execAgent).not.toHaveBeenCalled();
  });

  it('does not count the run that is settling right now as busy', async () => {
    const deps = createDeps({
      marker: { operationId: 'parent-op' },
      markerStatus: 'running',
      pending: [finished('a')],
    });

    await deliverBackgroundSubAgentResults(deps, {
      settledOperationId: 'parent-op',
      topicId: 'topic-1',
    });

    expect(deps.agentOperationModel.findById).not.toHaveBeenCalled();
    expect(deps.execAgent).toHaveBeenCalledTimes(1);
  });

  it('treats a mark left by a run that already ended as free', async () => {
    const deps = createDeps({
      marker: { operationId: 'old-op' },
      markerStatus: 'done',
      pending: [finished('a')],
    });

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    expect(deps.execAgent).toHaveBeenCalledTimes(1);
  });

  it('only delivers what it claimed, so a racing delivery cannot repeat a result', async () => {
    const deps = createDeps({ pending: [finished('a'), finished('b')] });
    deps.messageModel.claimBackgroundSubAgentDelivery.mockResolvedValue(['b']);

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    const { prompt } = deps.execAgent.mock.calls[0][0];
    expect(prompt).not.toContain('Answer of a');
    expect(prompt).toContain('Answer of b');
  });

  it('starts nothing when every result was already claimed', async () => {
    const deps = createDeps({ pending: [finished('a')] });
    deps.messageModel.claimBackgroundSubAgentDelivery.mockResolvedValue([]);

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    expect(deps.execAgent).not.toHaveBeenCalled();
  });

  it('hands the claims back when the turn cannot start', async () => {
    const deps = createDeps({ pending: [finished('a')] });
    deps.execAgent.mockRejectedValue(new Error('Topic topic-1 remained busy'));

    await expect(
      deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' }),
    ).resolves.toBeUndefined();

    expect(deps.messageModel.releaseBackgroundSubAgentDelivery).toHaveBeenCalledWith(['a']);
  });

  it('hands the claims back when the turn reports it did not start', async () => {
    const deps = createDeps({ pending: [finished('a')] });
    deps.execAgent.mockResolvedValue({ error: 'no model', success: false });

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    expect(deps.messageModel.releaseBackgroundSubAgentDelivery).toHaveBeenCalledWith(['a']);
  });

  it('wakes one branch at a time, oldest first', async () => {
    const deps = createDeps({
      pending: [
        finished('main-1'),
        finished('thread-1', { threadId: 'user-thread' }),
        finished('main-2'),
      ],
    });

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    expect(deps.messageModel.claimBackgroundSubAgentDelivery).toHaveBeenCalledWith(
      ['main-1', 'main-2'],
      expect.any(String),
    );
    expect(deps.execAgent).toHaveBeenCalledTimes(1);
  });

  it('marks a failed sub-agent as such and falls back to the topic agent', async () => {
    const deps = createDeps({
      pending: [finished('a', { agentId: null, state: { result: 'boom', status: 'error' } })],
    });

    await deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' });

    const params = deps.execAgent.mock.calls[0][0];
    expect(params.agentId).toBe('agent-1');
    expect(params.prompt).toContain('status="error"');
  });

  it('never throws, even when the topic lookup fails', async () => {
    const deps = createDeps({});
    deps.topicModel.findById.mockRejectedValue(new Error('db down'));

    await expect(
      deliverBackgroundSubAgentResults(deps, { topicId: 'topic-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('buildSubAgentEventPrompt', () => {
  it('emits one block without blank lines so it renders as a single card', () => {
    const prompt = buildSubAgentEventPrompt([
      {
        description: 'Say "hi" <now>',
        result: 'line 1\n\nline 2 ]]> end',
        status: 'completed',
        subAgentId: 'thread-1',
      },
    ]);

    expect(prompt.startsWith(`<${SUB_AGENT_EVENT_TAG} count="1">`)).toBe(true);
    expect(prompt.endsWith(`</${SUB_AGENT_EVENT_TAG}>`)).toBe(true);
    expect(prompt).not.toMatch(/\n\s*\n/);
    expect(prompt).toContain('description="Say &quot;hi&quot; &lt;now&gt;"');
    expect(prompt).toContain(']]]]><![CDATA[>');
    expect(prompt).toContain('<instruction>');
  });
});
