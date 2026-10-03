// tools/test-features.mjs — headless unit tests for src/audio/features.js (Phase 1A Step 1).
// Synthetic spectra with hand-computed exact answers. Run: `node tools/test-features.mjs` (or `npm run test:features`).
import { dbToLinear, spectralCentroid, spectralSpread, spectralRolloff, timbralFeatures }
  from '../src/audio/features.js';

let pass = 0, fail = 0;
const TOL = 1e-6;   // float32 storage (dbToLinear out, byte/float spectra) has ~1e-7 precision; exact-arithmetic cases still match to 0
function ok(name, got, want) {
  const good = Math.abs(got - want) <= TOL;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}  got=${got}  want=${want}`);
  good ? pass++ : fail++;
}
// build a length-n zero spectrum then set spikes via [bin,val] pairs
const spec = (n, ...spikes) => { const a = new Float32Array(n); for (const [b, v] of spikes) a[b] = v; return a; };

// ── dbToLinear (the float-FFT seam): 0dB->1, -20dB->0.1, -40dB->0.01, at/below floor & non-finite -> 0 ──
{
  const lin = dbToLinear([0, -20, -40, -100, -120, -Infinity], undefined, -100);
  ok('dbToLinear 0dB',   lin[0], 1);
  ok('dbToLinear -20dB', lin[1], 0.1);
  ok('dbToLinear -40dB', lin[2], 0.01);
  ok('dbToLinear floor', lin[3], 0);   // -100 is NOT > floor(-100)
  ok('dbToLinear below', lin[4], 0);
  ok('dbToLinear -Inf',  lin[5], 0);
}

// ── spectralCentroid ──
ok('centroid single spike', spectralCentroid(spec(16, [10, 5]), 43), 430);            // 10*43
ok('centroid two spikes',   spectralCentroid(spec(16, [4, 7], [8, 7]), 10), 60);      // mean(4,8)*10
ok('centroid zero energy',  spectralCentroid(spec(16), 43), 0);
ok('centroid band-limited', spectralCentroid(spec(32, [2, 1], [4, 1], [20, 100]), 1, 0, 10), 3); // bin20 excluded

// ── spectralSpread ──
ok('spread single spike', spectralSpread(spec(16, [10, 5]), 10), 0);                  // all mass at one bin
ok('spread two spikes',   spectralSpread(spec(16, [4, 7], [8, 7]), 10), 20);          // +/-20 Hz about 60
ok('spread zero energy',  spectralSpread(spec(16), 10), 0);

// ── spectralRolloff ──
{
  const flat = new Float32Array(100).fill(1);
  ok('rolloff flat 0.85', spectralRolloff(flat, 1, 0.85), 84);   // cum>=85 first at bin 84
  ok('rolloff flat 1.0',  spectralRolloff(flat, 1, 1.0), 99);    // cum>=100 at last bin
}
ok('rolloff spike',       spectralRolloff(spec(64, [30, 9]), 2, 0.5), 60);            // all mass at bin30 -> 30*2
ok('rolloff zero energy', spectralRolloff(spec(16), 2, 0.85), 0);

// ── timbralFeatures snapshot (one pass; matches the primitives) ──
{
  const f = timbralFeatures(spec(16, [4, 7], [8, 7]), 10, { rolloffPct: 0.5 });
  ok('timbral.centroidHz', f.centroidHz, 60);
  ok('timbral.spreadHz',   f.spreadHz, 20);
  ok('timbral.rolloffHz',  f.rolloffHz, 40);   // 0.5*14=7; cum hits 7 at bin4 -> 40
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
