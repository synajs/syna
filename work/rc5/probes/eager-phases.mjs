import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const target=process.env.SYNA_CORE ?? new URL('../source/packages/core/dist/index.js',import.meta.url).pathname;
const {definePackage,createRuntime}=await import(pathToFileURL(target));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const now=()=>performance.now();
const outputs=[];
async function scenario(name,{eager=true,timeout=60,grace,releaseAt,rawHang=false}){
 const gate=deferred();const t0=now();const events=[];let abortAt,rawRejectedAt,cleanupStartedAt,cleanupDoneAt,publicAt,outcome;
 const d=definePackage({name:`@review/${name}`,version:'1.0.0'});
 const S=d.service('service',{eager,loadTimeoutMs:timeout,failure:{attempts:1},setup(_,{signal,onDispose}){
  signal.addEventListener('abort',()=>{abortAt=now()-t0},{once:true});
  if(rawHang)return gate.promise.then(()=>({ok:true}));
  onDispose(async()=>{cleanupStartedAt=now()-t0;await gate.promise;cleanupDoneAt=now()-t0});
  return sleep(10).then(()=>{rawRejectedAt=now()-t0;throw Error('known setup failure')});
 }});
 const E=d.entry('entry',{requires:{s:S}});
 const runtime=createRuntime({services:[S],...(grace===undefined?{}:{limits:{disposalGraceMs:grace}}),diagnostics:{onEvent:e=>events.push({at:now()-t0,type:e.type,phase:e.phase})}});
 const op=eager?runtime.enter(E):(await runtime.enter(E)).deps.s.load();
 const tracked=op.then(()=>{publicAt=now()-t0;outcome='success'},e=>{publicAt=now()-t0;outcome={code:e.code,cause:e.cause?.code,note:e.cause?.details?.note??e.details?.note}});
 let timer;if(releaseAt!==undefined)timer=setTimeout(gate.resolve,Math.max(0,releaseAt-(now()-t0)));
 const samples=[];
 if(name==='default-grace-release-1200'){
  for(const ms of [100,300,600]){await sleep(Math.max(0,ms-(now()-t0)));samples.push({at:now()-t0,settled:outcome!==undefined,abortAt,live:runtime.inspect().liveEnvCount,events:[...events]});}
 }
 const safety=setTimeout(gate.resolve,5000);
 await tracked;clearTimeout(safety);if(timer)clearTimeout(timer);
 const beforeRelease={ledger:runtime.inspect().unsettledAttempts.map(a=>a.state),live:runtime.inspect().liveEnvCount};
 gate.resolve();await sleep(8);await runtime.dispose().catch(()=>{});
 const result={name,eager,timeout,grace:grace??2000,releaseAt,rawRejectedAt,abortAt,cleanupStartedAt,cleanupDoneAt,publicAt,outcome,beforeRelease,events,samples};
 if(eager){assert.equal(outcome.code,'ENTRY_ACTIVATION_FAILED');assert.equal(outcome.cause,'LOAD_TIMEOUT');assert.ok(abortAt<timeout+100,`internal eager wait not cut off: ${abortAt}`);assert.ok(publicAt>=abortAt);}
 else assert.equal(outcome.code,'LOAD_TIMEOUT');
 outputs.push(result);console.log(JSON.stringify(result));
}
await scenario('lazy-control',{eager:false});
await scenario('eager-grace-40',{grace:40});
await scenario('eager-grace-250',{grace:250});
await scenario('eager-default-grace',{ });
await scenario('default-grace-release-1200',{releaseAt:1200});
await scenario('raw-pending-control',{grace:90,rawHang:true});
const out=process.env.OUT??new URL('../evidence/eager-phases.json',import.meta.url);
await writeFile(out,JSON.stringify({node:process.version,target,outputs},null,2)+'\n');
