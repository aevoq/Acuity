// A minimal speaker so the walk can be heard before src/voice lands.
// src/voice (earcons, haptic indicator, queueing) replaces this: swap the
// import in App.tsx, nothing else changes, because both take a SpeakRequest.
//
// Screen-reader users get prompts through the page's live region instead
// (principle 6: never speak over their screen reader).

import type { Profile, SpeakRequest } from '../contracts';

export function speakFallback(req: SpeakRequest, profile: Profile): void {
  if (profile.usesScreenReader || typeof speechSynthesis === 'undefined') return;
  if (req.priority === 'interrupt') speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(req.text);
  u.rate = profile.speechRate;
  u.lang = 'en-GB';
  speechSynthesis.speak(u);
}
