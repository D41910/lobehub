import { SUB_AGENT_EVENT_TAG } from '@/const/plugin';

import { createRemarkXmlBlockPlugin } from '../remarkPlugins/createRemarkXmlBlockPlugin';
import { type MarkdownElement } from '../type';
import Component from './Render';

const SubAgentEventElement: MarkdownElement = {
  Component,
  remarkPlugin: createRemarkXmlBlockPlugin(SUB_AGENT_EVENT_TAG),
  scope: 'user',
  tag: SUB_AGENT_EVENT_TAG,
};

export default SubAgentEventElement;
