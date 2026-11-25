import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { buildPackDocs } from '../src/importers/packDocs';
import { createFakeStore, createMemoryKv, type DocData } from '../src/contract/store';
import { createSessionWriter } from '../src/store/sessionWriter';
import { createTrainerModel } from '../components/model';
import { buildPools, isPunish } from '../components/pools';
import { packForSummary } from '../components/packAdapter';
import { explainInput } from '../components/coachInput';
import { usablePunishStudy } from '../components/PunishStudy';
import { sanMoves } from '../lib/personal-pack';

const dir = path.join(process.cwd(), 'tests/fixtures/personal-pack');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('seam with B3: converter output loads through the model and gives the Trainer every field it reads', async () => {
  const out = buildPackDocs({ profile: JSON.parse(read('weakness_profile.json')), positions: read('mistake_positions.jsonl'), special: read('special_sets.jsonl') });
  const seed: Record<string, DocData> = Object.fromEntries(out.docs.map(d => [d.path, d.data]));
  const store = createFakeStore({ seed });
  const sessions = await createSessionWriter({ store, kv: createMemoryKv(), deviceId: 'd1', events: null });
  const model = createTrainerModel({ store, sessions, deviceId: 'd1' });
  try {
    await tick();
    const v = model.get();
    assert.equal(v.pack?.version, out.packVersion);
    const pools = buildPools({ bank: [], endgames: [], pack: v.pack, personal: [], drills: [] });
    assert.equal(pools.own.length, out.counts.cards + (out.counts.punish ?? 0));
    for (const card of pools.own) {
      const board = new Chess(card.fen);
      assert.doesNotThrow(() => board.move({ from: card.moves[0].slice(0, 2), to: card.moves[0].slice(2, 4), promotion: card.moves[0][4] }), card.id);
      const d = card.pack as Record<string, unknown>;
      assert.ok(Array.isArray(d.pvUci) && Array.isArray(d.occurrences) && (d.occurrences as unknown[]).length >= 1, card.id);
      for (const k of ['date', 'timeClass', 'playedSan', 'playedUci']) assert.equal(typeof d[k], 'string', `${card.id} ${k}`);
      assert.equal(typeof d.moveNumber, 'number');
      if (isPunish(card)) {
        assert.notEqual(new Chess(card.fen).turn(), d.ownerColor, 'punish: the opponent is to move, so the board faces his opponent');
        assert.ok(card.id.startsWith('punish-'));
      } else {
        assert.equal(new Chess(card.fen).turn(), d.ownerColor);
        if (Array.isArray(d.refutationPvUci) && d.refutationPvUci.length) {
          const input = explainInput(card, { fen: card.fen, uci: d.playedUci as string, index: 0 }, 'pack');
          assert.ok(input && input.refutationSan.length > 0 && typeof input.winBefore === 'number', 'game move: stored lines and numbers reach the coach');
        }
        if ((d.pvUci as string[]).length) assert.ok(sanMoves(card.fen, d.pvUci as string[]).length > 0);
      }
    }
    // B3 splits punish rows into graded cards and ungraded worked examples; both must arrive where they belong.
    assert.equal(pools.own.filter(isPunish).length, out.counts.punish ?? 0, 'graded punish cards are practised');
    assert.equal(v.pack?.punishStudy.length, out.counts.punishStudy ?? 0, 'ungraded punish items are kept for study');
    assert.ok((out.counts.punish ?? 0) + (out.counts.punishStudy ?? 0) > 0, 'the fixture yields punish material');
    assert.equal(usablePunishStudy(v.pack?.punishStudy ?? []).length, out.counts.punishStudy ?? 0, 'every worked example has its fields and a legal reply');
    for (const item of v.pack?.punishStudy ?? []) assert.ok(!pools.byId.has(item.id), 'never scheduled');
    const summary = packForSummary(v.pack);
    assert.ok(summary, 'summary pack from db documents');
    assert.equal(summary.study.length, out.counts.study, 'stalemate study items survive the relaxed path');
  } finally { model.dispose(); sessions.dispose(); }
});
