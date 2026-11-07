// PLACEHOLDER offline intent matcher, so the Ask box works with Wi-Fi off
// before src/agent's matcher lands. Swap the import in AskPanel.tsx for
// src/agent's when it exists: both return an Intent.

import type { Intent } from '../contracts';

const RULES: Array<{ re: RegExp; build: (u: string, m: RegExpMatchArray) => Omit<Intent, 'utterance' | 'via'> }> = [
  { re: /\b(help|emergency|999|i'?m lost|scared|danger)\b/, build: () => ({ name: 'help', confidence: 0.9 }) },
  { re: /\b(say (that|it) again|repeat|pardon|what did you say)\b/, build: () => ({ name: 'repeat', confidence: 0.9 }) },
  { re: /\b(what (do i do )?next|next step|which way now)\b/, build: () => ({ name: 'nextStep', confidence: 0.85 }) },
  { re: /\bwhere am i\b|\bwhat street\b/, build: () => ({ name: 'whereAmI', confidence: 0.9 }) },
  { re: /\b(on|to) my (left|right)\b|\b(ahead|in front|behind) (of )?me\b/, build: (u) => ({ name: 'leftRight', side: /left/.test(u) ? 'left' : /right/.test(u) ? 'right' : /behind/.test(u) ? 'behind' : 'ahead', confidence: 0.85 }) },
  { re: /\b(around|near|nearby|close to) me\b|\bwhat'?s (here|around)\b/, build: () => ({ name: 'aroundMe', confidence: 0.85 }) },
  { re: /\b(when|next) (is )?(the )?(next )?bus(es)?\b|\bbus (times|arrivals)\b|\bhow long (for|until) the\b|\bnext ([a-z]?\d{1,3})\b/, build: (u) => ({ name: 'busArrivals', line: u.match(/\b([a-z]?\d{1,3})\b/)?.[1], confidence: 0.8 }) },
  { re: /\b(nearest|closest) bus ?stop\b|\bwhere'?s the bus ?stop\b/, build: () => ({ name: 'nearestBusStop', confidence: 0.85 }) },
  { re: /\b(take me|navigate|directions|walk me|go|get me) to (.+)$/, build: (_u, m) => ({ name: 'navigateTo', query: m[2], confidence: 0.8 }) },
  {
    re: /\b(nearest|closest|where'?s|where is|find|is there) (an? |the )?(.+)$/,
    build: (_u, m) => ({ name: 'nearest', query: m[3].replace(/^(nearest|closest) /, '').replace(/ (near ?by|near me|around here)$/, ''), confidence: 0.75 }),
  },
];

export function quickMatch(utterance: string): Intent {
  const u = utterance.toLowerCase().replace(/[?.!]/g, '').trim();
  for (const r of RULES) {
    const m = u.match(r.re);
    if (m) return { ...r.build(u, m), utterance, via: 'keywords' };
  }
  return { name: 'unknown', utterance, confidence: 0, via: 'keywords' };
}
