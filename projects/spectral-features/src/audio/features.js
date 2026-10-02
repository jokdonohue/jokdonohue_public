// src/audio/features.js — pure spectral timbre descriptors (Phase 1A, Step 1 headless core).
//
// WHY: the mic engine already extracts energy (rms/bass), onset (SuperFlux), tempo/phase (PLL),
//   and pitch-class (chroma) — but NOTHING about TIMBRE / brightness. These three standard
//   descriptors add the "where is the spectral mass, how wide, how high" axis the modulation
//   layer wants (brightness -> hue/palette, spread -> texture, rolloff -> trail/air).
//
// CONTRACT: every function is PURE and DOMAIN-AGNOSTIC — `mag` is any indexable of non-negative
//   magnitudes (the app's Uint8Array `getByteFrequencyData`, OR a Float32Array linear magnitude
//   from a future float-FFT path). Output is in Hz (physical units); per-route normalisation/curves
//   are the modulation layer's job, NOT this primitive's. Zero-energy input -> 0 (never NaN).
//   `[lo, hi)` restrict to a musical sub-band (caller passes e.g. 250 Hz..5 kHz bins); defaults span all.

// Convert a dB spectrum (getFloatFrequencyData) to linear magnitude. The float-FFT seam: byte reads
// are already 0..255 magnitudes, but float reads are dB (~ -Inf..0). below `floorDb` -> 0 (silence).
export function dbToLinear(db, out = new Float32Array(db.length), floorDb = -100) {
  for (let i = 0; i < db.length; i++) {
    const v = db[i];
    out[i] = (Number.isFinite(v) && v > floorDb) ? Math.pow(10, v / 20) : 0;
  }
  return out;
}

// Spectral centroid (Hz): magnitude-weighted mean frequency — the "brightness" centre of gravity.
export function spectralCentroid(mag, binHz, lo = 0, hi = mag.length) {
  let num = 0, den = 0;
  for (let i = lo; i < hi; i++) { const m = mag[i]; num += i * m; den += m; }
  return den > 0 ? (num / den) * binHz : 0;
}

// Spectral spread (Hz): magnitude-weighted std-dev of frequency about the centroid — narrow (tonal,
// pure) vs wide (noisy, dense). Pass a precomputed `centroidHz` to avoid recomputing it.
export function spectralSpread(mag, binHz, centroidHz = null, lo = 0, hi = mag.length) {
  const c = centroidHz == null ? spectralCentroid(mag, binHz, lo, hi) : centroidHz;
  let num = 0, den = 0;
  for (let i = lo; i < hi; i++) { const m = mag[i], d = i * binHz - c; num += m * d * d; den += m; }
  return den > 0 ? Math.sqrt(num / den) : 0;
}

// Spectral rolloff (Hz): the frequency below which `pct` of the total magnitude lies — tracks the
// high-frequency "air"/cymbal energy that the centroid alone can blur.
export function spectralRolloff(mag, binHz, pct = 0.85, lo = 0, hi = mag.length) {
  let total = 0;
  for (let i = lo; i < hi; i++) total += mag[i];
  if (total <= 0) return 0;
  const target = total * Math.min(1, Math.max(0, pct));
  let cum = 0;
  for (let i = lo; i < hi; i++) { cum += mag[i]; if (cum >= target) return i * binHz; }
  return (hi - 1) * binHz;
}

// Convenience snapshot: the three timbral scalars in one pass (centroid computed once, reused by spread).
// This is the clean object the modulation layer reads; it does NO app-specific scaling.
export function timbralFeatures(mag, binHz, { lo = 0, hi = mag.length, rolloffPct = 0.85 } = {}) {
  const centroidHz = spectralCentroid(mag, binHz, lo, hi);
  return {
    centroidHz,
    spreadHz: spectralSpread(mag, binHz, centroidHz, lo, hi),
    rolloffHz: spectralRolloff(mag, binHz, rolloffPct, lo, hi),
  };
}
