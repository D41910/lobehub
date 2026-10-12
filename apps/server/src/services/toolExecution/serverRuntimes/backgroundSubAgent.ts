import type { LobeChatDatabase } from '@lobechat/database';

import { MessageModel } from '@/database/models/message';

/**
 * Background sub-agents one conversation may have running at once. Nobody waits
 * on them, so without a ceiling a looping parent could fan out unbounded spend.
 */
export const MAX_RUNNING_BACKGROUND_SUB_AGENTS = 5;

export interface BackgroundSubAgentRefusal {
  code: 'BACKGROUND_SUB_AGENT_LIMIT' | 'BACKGROUND_SUB_AGENT_UNSUPPORTED';
  message: string;
}

/**
 * Why a background sub-agent (`callSubAgent` / `callAgent` with
 * `runInBackground`) cannot start from this call; `undefined` when it can.
 *
 * Its answer is delivered as a callback message on the conversation's main
 * line plus a new turn of the conversation's agent, so the parent must be that
 * main line: not a group (several agents, one supervisor) and not a thread.
 */
export const checkBackgroundSubAgentAllowed = async (params: {
  db: LobeChatDatabase;
  groupId?: string | null;
  /** How to call the tool in the foreground instead, for the refusal text. */
  retryHint: string;
  threadId?: string | null;
  topicId?: string | null;
  userId: string;
  workspaceId?: string;
}): Promise<BackgroundSubAgentRefusal | undefined> => {
  const { db, groupId, retryHint, threadId, topicId, userId, workspaceId } = params;

  if (groupId) {
    return {
      code: 'BACKGROUND_SUB_AGENT_UNSUPPORTED',
      message: `Background runs are not supported in group conversations. ${retryHint}`,
    };
  }
  if (!topicId || threadId) {
    return {
      code: 'BACKGROUND_SUB_AGENT_UNSUPPORTED',
      message: `Background runs can only report back to a conversation's main line. ${retryHint}`,
    };
  }

  const running = await new MessageModel(db, userId, workspaceId).listBackgroundSubAgentCalls({
    scope: 'running',
    topicId,
  });
  if (running.length >= MAX_RUNNING_BACKGROUND_SUB_AGENTS) {
    return {
      code: 'BACKGROUND_SUB_AGENT_LIMIT',
      message: `${running.length} background runs are already going in this conversation (limit ${MAX_RUNNING_BACKGROUND_SUB_AGENTS}). Wait for their results to arrive, or ${retryHint.charAt(0).toLowerCase()}${retryHint.slice(1)}`,
    };
  }
};
