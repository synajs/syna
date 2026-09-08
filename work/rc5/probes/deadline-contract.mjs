// Deterministic deadlines, not timer-count assertions. Runs the unmodified core.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const target=process.env.SYNA_CORE??new URL('../source/packages/core/dist/index.js',import.meta.url).pathname;
const {definePackage,createRuntime}=await import(pathToFileURL(target));
const real={timeout:globalThis.setTimeout,clear:globalThis.clearTimeout,immediate:globalThis.setImmediate,dateNow:Date.now,perfDescriptor:Object.getOwnPropertyDescriptor(performance,'now')};
let clock=0;const timers=new Set();
globalThis.setTimeout=(callback,delay=0,...args)=>{const t={at:clock+Math.max(0,Number(delay)||0),callback,args,ref(){return this},unref(){return this},hasRef(){return false}};timers.add(t);return t};
globalThis.clearTimeout=t=>{timers.delete(t)};
Date.now=()=>1_000_000+clock;
Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await new Promise(r=>real.immediate(r));for(let i=0;i<12;i++)await Promise.resolve()};
async function advance(to){for(let safety=0;safety<500;safety++){const due=[...timers].filter(t=>t.at<=to).sort((a,b)=>a.at-b.at)[0];if(!due){clock=to;await flush();return;}clock=due.at;timers.delete(due);due.callback(...due.args);await flush();}throw Error('fake-clock livelock')}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const results=[];let failure;
try{
 // A deadline ends the eager wait; returning enter also requires bounded rollback.
 const d=definePackage({name:'@review/clock-eager',version:'1.0.0'});const gate=deferred();let abortAt,settledAt,outcome;const events=[];
 const s=d.service({eager:true,loadTimeoutMs:60,setup(_,{signal,onDispose}){signal.addEventListener('abort',()=>{abortAt=clock});onDispose(()=>gate.promise);return Promise.reject('setup failed')}});
 const e=d.entry({requires:{s}});const r=createRuntime({services:[s],limits:{disposalGraceMs:2000},diagnostics:{onEvent:x=>events.push({type:x.type,at:clock})}});
 void r.enter(e).then(()=>{settledAt=clock;outcome='ready'},x=>{settledAt=clock;outcome=x});await flush();
 await advance(59);assert.equal(abortAt,undefined);assert.equal(outcome,undefined);
 await advance(60);assert.equal(abortAt,60,'eager waiter must time out at 60, independently of rollback grace');assert.equal(outcome,undefined,'enter must not escape structured rollback');
 await advance(2059);assert.equal(outcome,undefined);
 await advance(2060);assert.equal(settledAt,2060);assert.equal(outcome.code,'ENTRY_ACTIVATION_FAILED');assert.equal(outcome.cause.code,'LOAD_TIMEOUT');assert.equal(r.inspect().liveEnvCount,0);
 results.push({name:'eager-two-phases',status:'PASS',abortAt,settledAt,loadTimeoutMs:60,graceMs:2000,events:[...events]});gate.resolve();await flush();await r.dispose();await flush();
 // Late joiners get their own window even though raw setup already rejected.
 const base=clock;const d2=definePackage({name:'@review/clock-lazy',version:'1.0.0'});const g2=deferred();let first,second;let setups=0;
 const s2=d2.service({loadTimeoutMs:40,setup(_,{onDispose}){setups++;onDispose(()=>g2.promise);return Promise.reject('failed')}});const e2=d2.entry({requires:{s:s2}});const r2=createRuntime({services:[s2]});const env=await r2.enter(e2);
 void env.deps.s.load().catch(e=>first={code:e.code,at:clock-base});await flush();await advance(base+39);assert.equal(first,undefined);await advance(base+40);assert.deepEqual(first,{code:'LOAD_TIMEOUT',at:40});
 await advance(base+70);void env.deps.s.load().catch(e=>second={code:e.code,at:clock-base});await flush();await advance(base+109);assert.equal(second,undefined);await advance(base+110);assert.deepEqual(second,{code:'LOAD_TIMEOUT',at:110});assert.equal(setups,1);assert.equal(env.state,'ready');
 results.push({name:'lazy-and-late-joiner',status:'PASS',first,second,secondJoinedAt:70,setups});g2.resolve();await flush();await r2.dispose();
}catch(e){failure={name:e.name,message:e.message,stack:e.stack};process.exitCode=1}
finally{globalThis.setTimeout=real.timeout;globalThis.clearTimeout=real.clear;Date.now=real.dateNow;if(real.perfDescriptor)Object.defineProperty(performance,'now',real.perfDescriptor);else delete performance.now;}
const record={target,node:process.version,method:'controlled global clock and timer driver in probe process only; no timer-count oracle',results,...(failure?{failure}:{} )};
await writeFile(process.env.OUT??new URL('../evidence/deadline-contract.json',import.meta.url),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record,null,2));
