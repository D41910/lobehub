import { LobeAgentApiName, LobeAgentIdentifier } from '@lobechat/builtin-tool-lobe-agent';
import { SUB_AGENT_EVENT_TAG } from '@lobechat/const';
import type { ExecAgentResult } from '@lobechat/types';
import { isAgentOperationInFlight, RequestTrigger } from '@lobechat/types';
import debug from 'debug';

import type { AgentOperationModel } from '@/database/models/agentOperation';
import type { MessageModel } from '@/database/models/message';
import type { TopicModel } from '@/database/models/topic';

import type { InternalExecAgentParams } from './types';

const log = debug('lobe-server:ai-agent:background-sub-agent');

/**
 * Background sub-agents (`callSubAgent({ runInBackground: true })`) report to a
 * parent that did not wait for them. A finished one stores its answer on its
 * placeholder (see `AgentRuntimeService.completeSubAgentBridge`); this module
 * hands those answers to the parent agent as one new turn of the topic.
 *
 * It runs when a background sub-agent finishes and whenever a run of the topic
 * settles, so an answer that arrives mid-turn is delivered once that turn ends
 * — the parent is never interrupted, and never waits on a result it chose not
 * to wait for. Each answer is claimed before its turn starts, so the two
 * triggers racing cannot deliver it twice; a turn that fails to start hands
 * its claims back for the next settle.
 */

export interface BackgroundSubAgentDeliveryDeps {
  agentOperationModel: Pick<AgentOperationModel, 'findById'>;
  execAgent: (params: InternalExecAgentParams) => Promise<ExecAgentResult>;
  messageModel: Pick<
    MessageModel,
    | 'claimBackgroundSubAgentDelivery'
    | 'listBackgroundSubAgentCalls'
    | 'releaseBackgroundSubAgentDelivery'
  >;
  topicModel: Pick<TopicModel, 'findById'>;
}

export interface BackgroundSubAgentResult {
  description?: string;
  result: string;
  status: 'completed' | 'error';
  subAgentId: string;
}

// ---------- wake prompt ----------

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

// The block must stay one CommonMark HTML block so the client renders it as a
// card, and CommonMark ends such a block at the first blank line.
const withoutBlankLines = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .join('\n');

const cdata = (text: string) =>
  `<![CDATA[\n${withoutBlankLines(text).replaceAll(']]>', ']]]]><![CDATA[>')}\n]]>`;

const INSTRUCTION =
  'Background sub-agents you started earlier have finished; their results are above. This message comes from the system, not from the user, and the user has not seen these results yet. Use them to carry on with what the user asked for and reply to the user. To follow up with a sub-agent, pass its id as callSubAgent subAgentId.';

/**
 * The message that wakes the parent: one `<subAgentEvent>` block with a
 * `<result>` per finished sub-agent. The model reads it as structured context;
 * the client renders it as a card ({@link SUB_AGENT_EVENT_TAG} markdown plugin).
 */
export const buildSubAgentEventPrompt = (results: BackgroundSubAgentResult[]): string => {
  const lines = [`<${SUB_AGENT_EVENT_TAG} count="${results.length}">`];
  for (const item of results) {
    const attributes = [
      `id="${escapeAttribute(item.subAgentId)}"`,
      `status="${item.status}"`,
      item.description ? `description="${escapeAttribute(item.description)}"` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`<result ${attributes}>${cdata(item.result)}</result>`);
  }
  lines.push(`<instruction>\n${INSTRUCTION}\n</instruction>`, `</${SUB_AGENT_EVENT_TAG}>`);
  return lines.join('\n');
};

// ---------- delivery ----------

type PendingCall = Awaited<
  ReturnType<BackgroundSubAgentDeliveryDeps['messageModel']['listBackgroundSubAgentCalls']>
>[number];

const readDescription = (rawArguments: string | null): string | undefined => {
  if (!rawArguments) return undefined;
  try {
    const description = (JSON.parse(rawArguments) as { description?: unknown }).description;
    return typeof description === 'string' && description.trim() ? description.trim() : undefined;
  } catch {
    return undefined;
  }
};

const toResult = (call: PendingCall): BackgroundSubAgentResult => ({
  description: readDescription(call.arguments),
  result:
    typeof call.state.result === 'string' && call.state.result
      ? call.state.result
      : 'Sub-agent finished without a textual answer.',
  status: call.state.status === 'error' ? 'error' : 'completed',
  subAgentId: typeof call.state.threadId === 'string' ? call.state.threadId : '',
});

/**
 * Whether another run still holds the topic. `settledOperationId` is the run
 * whose completion triggered this delivery: its mark may not be cleared yet,
 * but it is done. A mark naming a run that already ended is stale.
 */
const isTopicBusy = async (
  deps: BackgroundSubAgentDeliveryDeps,
  marker: { operationId?: string } | null | undefined,
  settledOperationId: string | undefined,
): Promise<boolean> => {
  const operationId = marker?.operationId;
  if (!operationId || operationId === settledOperationId) return false;

  const operation = await deps.agentOperationModel.findById(operationId);
  return !!operation && isAgentOperationInFlight(operation.status);
};

/**
 * Wake one parent conversation branch with its finished results. They go out
 * together: one turn reads them all, instead of one turn per sub-agent racing
 * for the same topic.
 */
const wakeParent = async (
  deps: BackgroundSubAgentDeliveryDeps,
  params: { agentId: string; calls: PendingCall[]; threadId: string | null; topicId: string },
): Promise<void> => {
  const { agentId, calls, threadId, topicId } = params;
  const claimed = new Set(
    await deps.messageModel.claimBackgroundSubAgentDelivery(
      calls.map((call) => call.id),
      new Date().toISOString(),
    ),
  );
  const results = calls.filter((call) => claimed.has(call.id)).map(toResult);
  if (results.length === 0) return;

  try {
    const started = await deps.execAgent({
      agentId,
      appContext: { threadId, topicId },
      autoStart: true,
      externalOrigin: {
        kind: 'sub_agent_results',
        label: results.map((item) => item.description ?? item.subAgentId).join(', '),
        provider: 'lobehub',
        resourceId: results[0].subAgentId,
      },
      prompt: buildSubAgentEventPrompt(results),
      trigger: RequestTrigger.Chat,
    });
    if (!started.success) throw new Error(started.error ?? 'the turn did not start');

    log('woke agent %s in topic %s with %d result(s)', agentId, topicId, results.length);
  } catch (error) {
    log('waking agent %s in topic %s failed, results kept: %O', agentId, topicId, error);
    await deps.messageModel.releaseBackgroundSubAgentDelivery([...claimed]);
  }
};

/**
 * Deliver the topic's finished background sub-agent results, unless another
 * run still holds the topic — its own completion calls this again. Never
 * throws: an undelivered result stays stored for the next attempt.
 */
export const deliverBackgroundSubAgentResults = async (
  deps: BackgroundSubAgentDeliveryDeps,
  params: { settledOperationId?: string; topicId: string },
): Promise<void> => {
  const { settledOperationId, topicId } = params;

  try {
    const topic = await deps.topicModel.findById(topicId);
    if (!topic) return;
    if (await isTopicBusy(deps, topic.metadata?.runningOperation, settledOperationId)) {
      log('topic %s is busy; results wait for its run to settle', topicId);
      return;
    }

    const pending = await deps.messageModel.listBackgroundSubAgentCalls({
      apiName: LobeAgentApiName.callSubAgent,
      identifier: LobeAgentIdentifier,
      scope: 'undelivered',
      topicId,
    });
    if (pending.length === 0) return;

    // One branch per wake, oldest first. The wake holds the topic, so a second
    // branch could not start beside it anyway; it goes out when this one settles.
    const [oldest] = pending;
    const agentId = oldest.agentId ?? topic.agentId;
    if (!agentId) return;
    const calls = pending.filter(
      (call) => (call.agentId ?? topic.agentId) === agentId && call.threadId === oldest.threadId,
    );

    await wakeParent(deps, { agentId, calls, threadId: oldest.threadId, topicId });
  } catch (error) {
    log('delivering background results for topic %s failed: %O', topicId, error);
  }
};
