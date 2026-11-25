Stockfish 19 lite, single-threaded WebAssembly engine

Copyright 2026 Chess.com, LLC; based on Stockfish by T. Romstad,
M. Costalba, J. Kiiski, G. Linscott and contributors. Nets by Chris Bao.
This engine is free software under GNU GPL version 3. No warranty.
The complete license is COPYING-GPL-3.0.txt in this directory.

The JavaScript and WebAssembly files are UNMODIFIED copies from the
npm package stockfish@19.0.1:
https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz

Corresponding source and build scripts are available beside these files:
  stockfish-source-19.0.1.tar.gz
  nn-61e7af4bb97d.nnue

Source archive: https://github.com/nmrugg/stockfish.js
Annotated tag v19.0.1 resolves to commit:
  0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6
Original archive URL:
https://codeload.github.com/nmrugg/stockfish.js/tar.gz/0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6
NNUE source:
https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue

To build: extract the source archive, copy the supplied .nnue into src/,
install Emscripten 6.0.9 and the source package's development dependencies,
then run: node build.js --single-threaded --lite -f
See the source README and build.js for full instructions and toolchain
requirements. Rebuilding byte-identical artifacts has not been verified.

SHA-256 checksums:
stockfish-19-lite-single.js
  ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a
stockfish-19-lite-single.wasm
  ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de
stockfish-source-19.0.1.tar.gz
  e5289a920554bf0069a6601c228e81d957c00522bb31c4343588dc5d7d251879
nn-61e7af4bb97d.nnue
  61e7af4bb97d51eeeb25d322916f86513b5cd3a827ce189c98c6e31946f99e5b

Keep the license, copyright notices, source archive, network, and build
instructions available when redistributing the engine. The application
communicates with the engine through UCI in a dedicated Web Worker.
The lite network trades strength for download size. Bounded-depth game
analysis is an estimate; it is not a proof of a unique best move.
