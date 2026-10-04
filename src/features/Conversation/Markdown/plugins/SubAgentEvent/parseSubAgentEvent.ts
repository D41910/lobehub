import { parseXmlAttributes } from '../remarkPlugins/createRemarkXmlBlockPlugin';

export interface SubAgentEventResult {
  description?: string;
  /** The sub-agent's id — its isolation thread. */
  id: string;
  result: string;
  status: 'completed' | 'error';
}

/** The text of every CDATA section in `raw`, joined; plain text when there is none. */
const cdataText = (raw: string) => {
  const sections = [...raw.matchAll(/<!\[CDATA\[([\S\s]*?)\]\]>/g)].map((m) => m[1]);
  const text = sections.length > 0 ? sections.join('') : raw;
  return text.replace(/^\n/, '').replace(/\n$/, '');
};

/**
 * Parses the `<result id status description><![CDATA[…]]></result>` children
 * of a `<subAgentEvent>` block, the message that delivers background sub-agent
 * results to their parent. Tolerant: anything it does not recognise is
 * skipped, so a malformed block renders as an empty card instead of throwing.
 */
export const parseSubAgentEvent = (raw: string): SubAgentEventResult[] => {
  if (!raw) return [];

  const results: SubAgentEventResult[] = [];
  // Attribute values are quoted, so a `>` inside one does not end the tag.
  for (const match of raw.matchAll(/<result\b((?:[^">]|"[^"]*")*)>([\S\s]*?)<\/result>/g)) {
    const attributes = parseXmlAttributes(match[1] ?? '');
    if (!attributes.id) continue;
    results.push({
      description: attributes.description || undefined,
      id: attributes.id,
      result: cdataText(match[2] ?? ''),
      status: attributes.status === 'error' ? 'error' : 'completed',
    });
  }
  return results;
};
