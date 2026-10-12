import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStreamHistoryError } from '../../utils/agentStreamTransport';
import { followAgentRun } from './followRun';

const { createLambdaClient, getAgentStreamAuthInfo, historyQuery, streamAgentEventsViaWebSocket } =
  vi.hoisted(() => {
    const historyQuery = vi.fn();
    return {
      createLambdaClient: vi.fn(() => ({
        aiAgent: { getOperationStreamHistory: { query: historyQuery } },
      })),
      getAgentStreamAuthInfo: vi.fn(),
      historyQuery,
      streamAgentEventsViaWebSocket: vi.fn(),
    };
  });

vi.mock('../../api/client', () => ({ createLambdaClient }));
vi.mock('../../api/http', () => ({ getAgentStreamAuthInfo }));
vi.mock('../../api/workspace', () => ({ resolveWorkspaceId: () => 'ws-1' }));
vi.mock('../../settings', () => ({ resolveAgentGatewayUrl: () => 'https://gateway.test' }));
vi.mock('../../utils/agentStream', () => ({ streamAgentEventsViaWebSocket }));
vi.mock('../../utils/logger', () => ({ log: { error: vi.fn() } }));

const auth = (token: string) => ({
  headers: { 'Oidc-Auth': token },
  serverUrl: 'https://server.test',
  token,
  tokenType: 'jwt',
});

describe('followAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyQuery.mockResolvedValue({
      available: true,
      events: [],
      hasMore: false,
      nextCursor: '0',
    });
  });

  it('reads each history page with re-resolved credentials, so an expired login refreshes', async () => {
    getAgentStreamAuthInfo
      .mockResolvedValueOnce(auth('first'))
      .mockResolvedValueOnce(auth('refreshed'));
    streamAgentEventsViaWebSocket.mockImplementation(async ({ readHistory }) => {
      const signal = new AbortController().signal;
      await readHistory('0', signal);
      await readHistory('1-0', signal);
      return { kind: 'completed', status: 'done' };
    });

    await expect(followAgentRun('op-1')).resolves.toEqual({ kind: 'completed', status: 'done' });

    expect(createLambdaClient).toHaveBeenNthCalledWith(1, auth('first'), 'ws-1');
    expect(createLambdaClient).toHaveBeenNthCalledWith(2, auth('refreshed'), 'ws-1');
    expect(historyQuery).toHaveBeenLastCalledWith(
      { cursor: '1-0', operationId: 'op-1' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('resolves an incomplete history as an unknown outcome, never a success', async () => {
    streamAgentEventsViaWebSocket.mockRejectedValue(new AgentStreamHistoryError('History expired'));

    await expect(followAgentRun('op-1')).resolves.toEqual({ kind: 'unknown' });
  });

  it('rethrows other failures so the caller can choose a fallback', async () => {
    streamAgentEventsViaWebSocket.mockRejectedValue(new Error('boom'));

    await expect(followAgentRun('op-1')).rejects.toThrow('boom');
  });
});
