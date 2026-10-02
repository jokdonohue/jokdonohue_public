// tools/test-contract.mjs — checks for input-contract behaviour documented in README.md,
// kept separate so the original tools/test-features.mjs stays byte-identical to its source.
// Run: `node tools/test-contract.mjs` (`npm test` runs it after the original 20 checks).
import { spectralRolloff } from '../src/audio/features.js';

let pass = 0, fail = 0;
function ok(name, got, want) {
  const good = got === want;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}  got=${got}  want=${want}`);
  good ? pass++ : fail++;
}
const spec = (n, ...spikes) => { const a = new Float32Array(n); for (const [b, v] of spikes) a[b] = v; return a; };

// README: "Rolloff takes a finite fraction and clamps it to [0, 1]."
// All mass at bin 30 with 2 Hz bins, so the rolloff for any fraction in (0, 1] is 60 Hz.
const spike = spec(64, [30, 9]);

// Above 1: clamped to 1. Without the clamp the target is never reached and the
// result falls through to the top of the band (126 Hz), so this case discriminates.
ok('rolloff pct > 1 clamps to 1', spectralRolloff(spike, 2, 1.5), spectralRolloff(spike, 2, 1));
ok('rolloff pct > 1 value', spectralRolloff(spike, 2, 1.5), 60);

// Below 0: clamped to 0, which returns the first bin of the band (lo * binHz).
// For non-negative magnitudes any negative target is met at the first bin anyway,
// so this documents the contract rather than discriminating the lower clamp.
ok('rolloff pct < 0 clamps to 0', spectralRolloff(spike, 2, -0.5, 5, 40), spectralRolloff(spike, 2, 0, 5, 40));
ok('rolloff pct < 0 value', spectralRolloff(spike, 2, -0.5, 5, 40), 10);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
