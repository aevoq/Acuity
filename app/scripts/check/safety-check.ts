// The ADR-013 safety check: no answer may judge crossing safety.
//   npx tsx scripts/check/safety-check.ts
import { ADVISORY, isUnsafe, makeSafe } from '../../src/vision/safety';
import { createLightWatcher } from '../../src/vision/lights';

const unsafe = [
  "It's safe to cross now.", 'You can cross.', 'The road is clear.', 'Go now, the light is green.',
  'No cars are coming, so you may proceed.', 'It looks clear to go.', 'You should cross now.',
  "It's not dangerous, you can cross.", "Don't worry, it's safe to cross.",
];
const fine = [
  'The traffic light looks red.', 'A crossing is about five metres ahead, slightly left.',
  'The pedestrian signal looks green. Check with your cane or dog and listen to the traffic.',
  "I can't tell you when it is safe to cross.", 'There is a door on your right.', 'I cannot say if it is safe to cross.',
];
let bad = 0;
for (const t of unsafe) if (!isUnsafe(t)) { bad++; console.log('MISSED unsafe:', t); }
for (const t of fine) if (isUnsafe(t)) { bad++; console.log('FALSE alarm:', t); }
const mixed = makeSafe('There is a zebra crossing ahead. It is safe to cross now. Cars are stopped.');
console.log('mixed →', mixed);
if (!mixed.includes(ADVISORY) || /safe to cross now/i.test(mixed)) bad++;

const said: string[] = [];
const w = createLightWatcher((s, sentence) => said.push(`${s}: ${sentence}`));
const L = (c: string) => ({ lights: [{ colour: c as 'red', confidence: 0.6, box: [0, 0, 1, 1] as [number, number, number, number] }], objects: [], brightness: 100, ms: 1 });
for (const d of [L('red'), L('red'), L('green'), L('red'), L('green'), L('green'), { lights: [], objects: [], brightness: 100, ms: 1 }])
  w.feed(d);
console.log('light watcher said:\n  ' + said.join('\n  '));
if (said.length !== 2) bad++; // red once, then green once: the single-frame flips are ignored
// A pelican crossing: red for the traffic and green for people in one frame.
const pel = { lights: [{ colour: 'red' as const, confidence: 0.84, box: [0, 0, 1, 1] as [number, number, number, number] }, { colour: 'green' as const, confidence: 0.67, box: [0, 0, 1, 1] as [number, number, number, number] }], objects: [], brightness: 100, ms: 1 };
const said2: string[] = [];
const w2 = createLightWatcher((s) => said2.push(s));
w2.feed(pel); w2.feed(pel);
console.log('pelican crossing →', said2.join(', '));
if (said2[0] !== 'mixed') bad++;
console.log(bad ? `FAILED (${bad})` : 'all safety checks passed');
process.exit(bad ? 1 : 0);
