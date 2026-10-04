import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

import { SUB_AGENT_EVENT_TAG } from '@/const/plugin';

import { createRemarkXmlBlockPlugin } from '../remarkPlugins/createRemarkXmlBlockPlugin';
import { parseSubAgentEvent } from './parseSubAgentEvent';

// Shaped like the server's `buildSubAgentEventPrompt`: no blank lines, answers in CDATA.
const SERVER_BLOCK = `<subAgentEvent count="2">
<result id="thd_1" status="completed" description="Find &quot;X&quot; &lt;fast>"><![CDATA[
## Findings
- one ]]]]><![CDATA[> two
]]></result>
<result id="thd_2" status="error"><![CDATA[
Sub-agent did not complete (error): Budget exceeded
]]></result>
<instruction>
Background sub-agents you started earlier have finished.
</instruction>
</subAgentEvent>`;

const runRemark = (markdown: string) => {
  const processor = unified()
    .use(remarkParse)
    .use(createRemarkXmlBlockPlugin(SUB_AGENT_EVENT_TAG));
  return processor.runSync(processor.parse(markdown)) as any;
};

describe('subAgentEvent', () => {
  it('turns the server block into one card node', () => {
    const tree = runRemark(`${SERVER_BLOCK}\n\nAfter the card.`);
    const blocks = tree.children.filter((node: any) => node.type === `${SUB_AGENT_EVENT_TAG}Block`);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].data.hProperties).toEqual({ count: '2' });
    expect(tree.children.at(-1).type).toBe('paragraph');
  });

  it('reads every result with its status, label and answer', () => {
    const tree = runRemark(SERVER_BLOCK);
    const inner = tree.children[0].data.hChildren[0].value;

    expect(parseSubAgentEvent(inner)).toEqual([
      {
        description: 'Find "X" <fast>',
        id: 'thd_1',
        result: '## Findings\n- one ]]> two',
        status: 'completed',
      },
      {
        description: undefined,
        id: 'thd_2',
        result: 'Sub-agent did not complete (error): Budget exceeded',
        status: 'error',
      },
    ]);
  });

  it('skips results without an id and survives garbage', () => {
    expect(parseSubAgentEvent('<result status="completed">orphan</result>')).toEqual([]);
    expect(parseSubAgentEvent('not a block at all')).toEqual([]);
    expect(parseSubAgentEvent('')).toEqual([]);
  });
});
