// The safety check every camera or model answer passes before it is spoken
// (ADR-013, principle 1: never say "safe to cross"). A model can be told not
// to judge safety; this makes sure, in code, that it never reaches the person.

/** What we say instead of any safety judgement. */
export const ADVISORY =
  "I can't tell you when it is safe to cross. Use your cane or dog, listen to the traffic, and feel for the rotating cone under the push-button box.";

const UNSAFE = [
  /\b(it'?s|it is|that'?s|looks|seems|now)\s+(safe|clear|okay|ok|fine)\s+(to\s+)?(cross|go|walk)/i,
  /\bsafe\s+to\s+(cross|go|walk|proceed)/i,
  /\byou\s+(can|may|should|could)\s+(now\s+)?(cross|go|walk|proceed)\b/i,
  /\b(go|cross)\s+(now|ahead)\b/i,
  /\bno\s+(cars?|traffic|vehicles?)\s+(are\s+)?(coming|approaching)\b/i,
  /\b(the\s+)?road\s+is\s+(clear|empty)\b/i,
];

/** "can't tell you", "not safe", "never say"…: a refusal or a warning, not a judgement. */
const NEGATED = new RegExp(
  [
    // "I can't tell you when it is …", "I cannot say whether it is …", "unable to judge if it's …"
    String.raw`\b(can'?t|cannot|can not|unable to|won'?t|never|don'?t)\s+(tell|say|know|judge|confirm|promise|guarantee|be sure)\b[^.!?]{0,30}$`,
    // "… is not / isn't / never …" right before "safe"
    String.raw`\b(not|isn'?t|never|n'?t)\s+(be\s+)?$`,
  ].join('|'),
  'i',
);

export function isUnsafe(text: string): boolean {
  return UNSAFE.some((re) => {
    const m = re.exec(text);
    if (!m) return false;
    // Only a statement about "safe" can be negated ("I can't tell you when it is safe to cross").
    // "It's not dangerous, you can cross" is still a go signal.
    const safeAt = m[0].toLowerCase().indexOf('safe');
    if (safeAt < 0) return true;
    return !NEGATED.test(text.slice(0, m.index + safeAt));
  });
}

/**
 * Make a model's answer safe to speak: any sentence that judges safety is
 * replaced by the advisory (once), and the answer is cut to `maxWords`.
 */
export function makeSafe(text: string, maxWords = 60): string {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  let replaced = false;
  const out: string[] = [];
  for (const s of sentences) {
    if (isUnsafe(s)) {
      if (!replaced) out.push(ADVISORY);
      replaced = true;
    } else out.push(s);
  }
  const words = out.join(' ').split(' ');
  return words.length > maxWords ? `${words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '')}…` : words.join(' ');
}
