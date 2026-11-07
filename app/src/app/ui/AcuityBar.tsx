// What Acuity is doing, for everyone who can see it: an orb that shows her
// state (waiting for "Hey Acuity", listening, hearing you, thinking,
// speaking) and live captions of the conversation. The words are also in the
// page's live region, so the captions themselves are hidden from screen
// readers (no double reading).

import type { EarsState } from '../../agent/ears';
import { Icon } from './Controls';

export type AcuityState = EarsState | 'speaking';

export interface Caption {
  id: number;
  who: 'you' | 'acuity';
  text: string;
}

const STATUS: Record<AcuityState, string> = {
  off: 'Not listening. Tap Talk to speak',
  wake: 'Say "Hey Acuity"',
  listening: 'Listening…',
  hearing: 'Hearing you…',
  thinking: 'Thinking…',
  speaking: 'Acuity is speaking',
};

export function Orb({ state, size = 44 }: { state: AcuityState; size?: number }) {
  return (
    <span className={`orb orb-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="orb-core" />
      <span className="orb-ring" />
      <span className="orb-bars">
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export interface AcuityBarProps {
  state: AcuityState;
  captions: Caption[];
  onTalk: () => void;
}

export function AcuityBar({ state, captions, onTalk }: AcuityBarProps) {
  const last = captions.slice(-2);
  return (
    <div className={`acuity-bar acuity-${state}`}>
      <div className="acuity-head">
        <Orb state={state} />
        <div className="acuity-status" aria-hidden="true">
          <strong>Acuity</strong>
          <span>{STATUS[state]}</span>
        </div>
        <button type="button" className="btn outline acuity-talk" onClick={onTalk} aria-label="Talk to Acuity now">
          <Icon name="mic" />
          Talk
        </button>
      </div>
      {last.length > 0 && (
        <div className="acuity-captions" aria-hidden="true">
          {last.map((c) => (
            <p key={c.id} className={`cap cap-${c.who}`}>
              <span className="cap-who">{c.who === 'you' ? 'You' : 'Acuity'}</span>
              {c.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export interface WelcomeProps {
  onStart: () => void;
  onSkip: () => void;
}

/**
 * First screen. Browsers only let a page speak and open the microphone after
 * a tap or a key, so Acuity starts from one big button (focused, so a screen
 * reader lands on it; Enter or Space starts).
 */
export function Welcome({ onStart, onSkip }: WelcomeProps) {
  return (
    <section className="welcome" aria-labelledby="welcome-h">
      <div className="welcome-inner">
        <Orb state="wake" size={120} />
        <h1 id="welcome-h">Acuity</h1>
        <p>Your walking guide. Tell me where you want to go, and I'll take you there, by voice.</p>
        <button type="button" className="btn primary big welcome-start" onClick={onStart} autoFocus>
          <Icon name="mic" />
          Start talking to Acuity
        </button>
        <button type="button" className="btn outline" onClick={onSkip}>
          Use the app by touch instead
        </button>
        <p className="fine">The microphone is used only on this device. During a walk Acuity listens for "Hey Acuity"; you can turn that off in Settings.</p>
      </div>
    </section>
  );
}
