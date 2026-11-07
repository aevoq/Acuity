// Ask the app (F4). Big buttons for the commonest questions (the PRD's cut
// line) plus a free-text box. The text goes to Gemini when online (it only
// picks the tool) and to the offline keyword matcher otherwise, or when Gemini
// fails. Either way the answer comes from runIntent → the tool layer.

import { useState, type FormEvent } from 'react';
import type { Intent } from '../contracts';
import { geminiPickTool } from '../net/gemini';
import { useNetworkMode } from '../net/useConnectivity';
import { quickMatch } from './quickMatch';

export interface AskPanelProps {
  disabled: boolean;
  onIntent: (intent: Intent) => Promise<void>;
}

const QUICK: Array<{ label: string; intent: Omit<Intent, 'utterance' | 'via' | 'confidence'> }> = [
  { label: 'Where am I?', intent: { name: 'whereAmI' } },
  { label: "What's around me?", intent: { name: 'aroundMe' } },
  { label: "What's on my left?", intent: { name: 'leftRight', side: 'left' } },
  { label: "What's on my right?", intent: { name: 'leftRight', side: 'right' } },
  { label: 'Nearest bus stop', intent: { name: 'nearestBusStop' } },
  { label: 'Next buses', intent: { name: 'busArrivals' } },
];

export function AskPanel({ disabled, onIntent }: AskPanelProps) {
  const mode = useNetworkMode();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState<string | null>(null);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const u = text.trim();
    if (!u) return;
    setBusy(true);
    let intent: Intent | null = null;
    if (mode === 'online') {
      const r = await geminiPickTool(u);
      if (r.ok) {
        intent = r.intent;
        setHow('Understood online (Gemini picked the tool; the answer is from the map data).');
      } else setHow(`Understood offline. Gemini unavailable: ${r.message}`);
    } else setHow('Understood offline (keyword matcher).');
    intent ??= quickMatch(u);
    await onIntent(intent);
    setBusy(false);
  };

  return (
    <section aria-labelledby="ask-h" className="panel">
      <h2 id="ask-h">Ask</h2>
      <div className="button-row">
        {QUICK.map((q) => (
          <button key={q.label} type="button" disabled={disabled} onClick={() => onIntent({ ...q.intent, utterance: q.label, confidence: 1, via: 'keywords' })}>
            {q.label}
          </button>
        ))}
      </div>
      <form onSubmit={ask} className="search" style={{ marginTop: 8 }}>
        <label htmlFor="ask" className="visually-hidden">
          Ask a question
        </label>
        <input id="ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask anything, e.g. is there a chemist nearby?" autoComplete="off" disabled={disabled} />
        <button type="submit" className="big" disabled={disabled || busy}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>
      {how && <p className="muted small">{how}</p>}
    </section>
  );
}
