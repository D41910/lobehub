import { describe, expect, it } from 'vitest';

import type { PipelineContext } from '../../types';
import { TaskCallbackMessageProcessor } from '../TaskCallbackMessage';

describe('TaskCallbackMessageProcessor', () => {
  const createContext = (messages: any[]): PipelineContext => ({
    initialState: { messages: [] },
    isAborted: false,
    messages,
    metadata: {},
  });

  it('surfaces a task-callback card as a tagged user turn the model can read', async () => {
    const processor = new TaskCallbackMessageProcessor();
    const context = createContext([
      { content: 'Fix the bug', role: 'user' },
      { content: 'Dispatched T-42', role: 'assistant' },
      {
        content: 'Fixed the null deref in foo().',
        metadata: { taskCallback: { identifier: 'T-42', reason: 'done', taskId: 't1' } },
        role: 'taskCallback',
      },
    ]);

    const result = await processor.process(context);

    expect(result.messages).toHaveLength(3);
    const last = result.messages[2];
    expect(last.role).toBe('user');
    expect(last.content).toContain('<task_result task="T-42" status="done">');
    expect(last.content).toContain('Fixed the null deref');
    expect(result.metadata.taskCallbackMessagesSurfaced).toBe(1);
  });

  it('carries the failure reason into the wrapper status', async () => {
    const processor = new TaskCallbackMessageProcessor();
    const context = createContext([
      {
        content: 'The task failed.',
        metadata: { taskCallback: { identifier: 'T-7', reason: 'error', taskId: 't7' } },
        role: 'taskCallback',
      },
    ]);

    const result = await processor.process(context);

    expect(result.messages[0].content).toContain('status="error"');
  });

  it('drops an empty UI-only task-callback card from the model context', async () => {
    const processor = new TaskCallbackMessageProcessor();
    const context = createContext([
      { content: 'Hello', role: 'user' },
      { content: '   \n ', role: 'taskCallback' },
      { content: 'Hi', role: 'assistant' },
    ]);

    const result = await processor.process(context);

    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.metadata.taskCallbackMessagesSurfaced).toBe(0);
  });

  // A background sub-agent's answer rides the same role; the model must read it
  // as that sub-agent reporting back, with the id it can follow up with.
  it('wraps a background sub-agent answer with its id, name and status', async () => {
    const processor = new TaskCallbackMessageProcessor();
    const context = createContext([
      {
        content: 'Found three sources.',
        metadata: {
          subAgentCallback: { name: 'Research "X"', status: 'completed', threadId: 'thd_1' },
        },
        role: 'taskCallback',
      },
    ]);

    const result = await processor.process(context);

    expect(result.messages[0]).toMatchObject({
      content:
        '<sub_agent_result id="thd_1" name="Research &quot;X&quot;" status="completed">\nFound three sources.\n</sub_agent_result>',
      role: 'user',
    });
  });
});
