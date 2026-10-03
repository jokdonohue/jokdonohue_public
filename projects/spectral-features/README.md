# Spectral features

Small standalone JavaScript functions for converting decibel spectra to linear magnitude and computing spectral centroid, spread, and rolloff. The functions and 20 synthetic checks preserve the existing audio-math implementation; `tools/test-contract.mjs` adds checks for the input contract documented below.

Run with Node.js and npm; no dependency installation is needed:

```sh
npm test
```

For centroid, spread, and rolloff, supply finite nonnegative magnitudes and a finite positive frequency step (`binHz`). Optional sub-band bounds are integer indices satisfying `0 <= lo <= hi <= mag.length`; the upper bound is exclusive. Zero-energy input returns zero. Rolloff takes a finite fraction and clamps it to `[0, 1]`. A supplied centroid uses Hz.

`dbToLinear` maps values at or below its finite `floorDb` threshold and nonfinite inputs to zero. Its optional reusable output buffer must be at least as long as the input.

No project license has been selected.
