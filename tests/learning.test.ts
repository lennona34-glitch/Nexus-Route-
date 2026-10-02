import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../src/tools/learning.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RoutingEngine } from '../src/router/engine.js';

const make = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-learning-'));
const lesson = { action: 'save', key: 'rounding', problem: 'round invoice pennies', fix: 'Round the total once', scope: 'invoice fixture v1' };
describe('learning loop', () => {
  it('persists, retrieves, corrects and deletes lessons without trusting model status', async () => {
    const ws=make();
    fs.writeFileSync(path.join(ws,'rounding.test.cjs'), "const test=require('node:test'); const assert=require('node:assert/strict'); test('rounding',()=>assert.equal(Math.round(1.2),1));");
    const checked:any = await LearningStore.execute(ws,{action:'check',test:'rounding.test.cjs'});
    const saved:any = await LearningStore.execute(ws, {...lesson, status:'unverified', evidence_id:checked.evidence.id});
    expect(saved.lesson.status).toBe('check_passed');
    expect(LearningStore.context(ws,'invoice rounding')).toContain('Round the total once');
    expect(LearningStore.context(make(),'invoice')).toBe('');
    await LearningStore.execute(ws,{...lesson,fix:'Use integer pennies',evidence_id:checked.evidence.id});
    expect(LearningStore.list(ws)).toHaveLength(1);
    expect(LearningStore.list(ws)[0].fix).toBe('Use integer pennies');
    await LearningStore.execute(ws,{action:'delete',key:'rounding'});
    expect(LearningStore.list(ws)).toHaveLength(0);
  });
  it('requires real workspace evidence and invalidates it after source changes', async () => {
    const ws=make();
    fs.writeFileSync(path.join(ws,'sum.cjs'),'module.exports = (a,b) => a+b;');
    fs.writeFileSync(path.join(ws,'sum.test.cjs'),"const test=require('node:test'); const assert=require('node:assert/strict'); test('sum',()=>assert.equal(require('./sum.cjs')(2,3),5));");
    await expect(LearningStore.execute(ws,{...lesson,evidence_id:'invented'})).rejects.toThrow('Unknown evidence');
    const checked:any=await LearningStore.execute(ws,{action:'check',test:'sum.test.cjs',files:['sum.cjs']});
    expect(checked.evidence.passed).toBe(true);
    const saved:any=await LearningStore.execute(ws,{...lesson,evidence_id:checked.evidence.id});
    expect(saved.lesson.status).toBe('check_passed');
    fs.writeFileSync(path.join(ws,'sum.cjs'),'module.exports = () => 0;');
    expect(LearningStore.list(ws)[0].status).toBe('stale');
    const failed:any=await LearningStore.execute(ws,{action:'check',test:'sum.test.cjs',files:['sum.cjs']});
    expect(failed.evidence.passed).toBe(false);
    await expect(LearningStore.execute(ws,{...lesson,evidence_id:failed.evidence.id})).rejects.toThrow('did not pass');
    await expect(LearningStore.execute(make(),{...lesson,evidence_id:checked.evidence.id})).rejects.toThrow('Unknown evidence');
    await expect(LearningStore.execute(ws,{action:'check',test:path.join(os.tmpdir(),'outside.test.cjs')})).rejects.toThrow();
  });
  it('preserves a corrupt store instead of overwriting it', async () => {
    const ws=make(); fs.writeFileSync(LearningStore.file(ws),'broken');
    await expect(LearningStore.execute(ws,lesson)).rejects.toThrow();
    expect(fs.readFileSync(LearningStore.file(ws),'utf8')).toBe('broken');
  });
  it('tracks source URLs with expiry status', async () => {
    const ws=make(); fs.writeFileSync(path.join(ws,'source.test.cjs'), "const test=require('node:test'); test('source',()=>{});");
    const checked:any=await LearningStore.execute(ws,{action:'check',test:'source.test.cjs'});
    const saved:any=await LearningStore.execute(ws,{...lesson,evidence_id:checked.evidence.id,sources:['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isFinite'],source_records:[{url:'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isFinite',checkedAt:'2026-09-08T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z'}]});
    expect(saved.lesson.status).toBe('check_passed');
    expect(LearningStore.list(ws)[0].source_status).toBe('fresh');
    await LearningStore.execute(ws,{...lesson,evidence_id:checked.evidence.id,source_records:[{url:'https://example.com',checkedAt:'2020-01-01T00:00:00.000Z',expiresAt:'2020-02-01T00:00:00.000Z'}]});
    expect(LearningStore.list(ws)[0].source_status).toBe('stale');
  });
  it('exposes learning tools and recalls lessons in a coding request', async () => {
    const ws=make(); const original=ToolRegistry.getWorkspaceDir();
    ToolRegistry.setWorkspaceDir(ws);
    try {
      fs.writeFileSync(path.join(ws,'rounding.test.cjs'), "const test=require('node:test'); const assert=require('node:assert/strict'); test('rounding',()=>assert.equal(Math.round(1.2),1));");
      const checked=JSON.parse(await ToolRegistry.executeTool('learning_memory',{action:'check',test:'rounding.test.cjs'}));
      const saved=JSON.parse(await ToolRegistry.executeTool('learning_memory',{...lesson,evidence_id:checked.evidence.id}));
      expect(saved.success).toBe(true);
      const req:any={model:'nexus-qwen3-brain',enable_tools:true,messages:[{role:'user',content:'Fix invoice rounding in totals.js'}]};
      const prepared=(RoutingEngine.prototype as any).ensureAutonomousPrompt.call({},req);
      expect(prepared.tools.some((t:any)=>t.function.name==='learning_memory')).toBe(true);
      expect(prepared.messages[0].content).toContain('RETRIEVED LESSONS');
      expect(prepared.messages[0].content).toContain('Round the total once');
      expect(prepared.recalled_lessons).toEqual(['rounding']);
      const external=(RoutingEngine.prototype as any).ensureAutonomousPrompt.call({},{...req,client_agent_mode:true});
      expect(external).toEqual({...req,client_agent_mode:true});
    } finally {ToolRegistry.setWorkspaceDir(original);}
  });
});
