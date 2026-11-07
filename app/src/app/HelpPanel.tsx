// Minimal emergency and help (F6, ADR-008). Opens the phone's own dialler or
// SMS screen with everything filled in; the person confirms there. Nothing is
// ever called or sent automatically. Calls and SMS use the mobile network,
// not data, so they often work when data does not. (On a laptop, the links
// hand off to whatever the computer uses for tel: and sms:.)
//
// Person 1 owns the full help screen; this is the base it can replace.

import type { Position, Profile } from '../contracts';

export interface HelpPanelProps {
  here: Position;
  street: string | null;
  profile: Profile;
  onClose: () => void;
}

export function HelpPanel({ here, street, profile, onClose }: HelpPanelProps) {
  const where = `${street ? `${street}, ` : ''}${here.lat.toFixed(5)}, ${here.lng.toFixed(5)}`;
  const sms = `I need help. My location: ${where} https://maps.google.com/?q=${here.lat.toFixed(5)},${here.lng.toFixed(5)}`;
  const contact = profile.trustedContact;
  return (
    <section aria-labelledby="help-h" className="panel help-panel" role="region">
      <h2 id="help-h">Help</h2>
      <p>Each option opens your phone's own screen with the details filled in. Nothing happens until you confirm there.</p>
      <div className="button-row">
        <a className="big help-link" href="tel:999">
          Call 999
        </a>
        <a className="big help-link" href={`sms:${contact?.phone ?? ''}?&body=${encodeURIComponent(sms)}`}>
          Text my location{contact ? ` to ${contact.name}` : ''}
        </a>
        {contact && (
          <a className="big help-link" href={`tel:${contact.phone}`}>
            Call {contact.name}
          </a>
        )}
        <button type="button" onClick={onClose}>
          Close help
        </button>
      </div>
      <p className="muted small">Your location: {where}</p>
    </section>
  );
}
