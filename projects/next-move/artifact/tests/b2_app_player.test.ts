import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyPlayerColor } from '../lib/player';
test('each imported game identifies the account independently regardless of color or case',()=>{
  assert.equal(identifyPlayerColor({White:'MyName',Black:'Opponent'},'myname'),'w');
  assert.equal(identifyPlayerColor({White:'Opponent',Black:'MYNAME'},' myname '),'b');
  assert.equal(identifyPlayerColor({White:'Opponent',Black:'Different'},'myname'),undefined);
});
test('anonymous and ambiguous player headers require an explicit side choice',()=>{
  assert.equal(identifyPlayerColor({White:'White',Black:'Black'},''),undefined);
  assert.equal(identifyPlayerColor({White:'MyName',Black:'myname'},'myname'),undefined);
  assert.equal(identifyPlayerColor({},'myname'),undefined);
});
