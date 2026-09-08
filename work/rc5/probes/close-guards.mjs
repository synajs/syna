import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const target=process.env.SYNA_CORE??new URL('../source/packages/core/dist/index.js',import.meta.url).pathname;
const {definePackage,createRuntime}=await import(pathToFileURL(target));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const turn=()=>new Promise(r=>setImmediate(r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const flat=e=>e instanceof AggregateError?e.errors.flatMap(flat):[e];
const results=[];
for(const spec of [
 {name:'same-env',outer:'child',inner:'child'},
 {name:'async-dispose',outer:'child',inner:'child',symbol:true},
 {name:'child-to-parent',outer:'child',inner:'root'},
 {name:'parent-to-child',outer:'root',inner:'child'},
 {name:'root-to-root',outer:'root',inner:'root'},
 {name:'root-to-runtime',outer:'root',inner:'runtime'},
 {name:'runtime-to-runtime',outer:'runtime',inner:'runtime'},
 {name:'runtime-to-child',outer:'runtime',inner:'child'},
]){
 const d=definePackage({name:`@review/guard-${spec.name}`,version:'1.0.0'});
 const gate=deferred(),entered=deferred(),boom=Object.assign(Error(spec.name),{marker:spec.name});
 let inner,innerState='absent',outerState='pending',cleanups=0,starts=0,loadResult,states,holder={};
 const D=d.service('dormant',{setup(){starts++;return {}}});
 const S=d.service('listener',{requires:{d:D},setup({d},{signal,onDispose}){
  signal.addEventListener('abort',()=>{
   states={child:holder.child.state,root:holder.root.state};
   loadResult=d.load().then(()=> 'unexpected-success',e=>e.code);
   const obj=holder[spec.inner];innerState='pending';inner=spec.symbol?obj[Symbol.asyncDispose]():obj.dispose();
   inner.then(()=>innerState='fulfilled',()=>innerState='rejected');
  },{once:true});
  onDispose(async()=>{cleanups++;entered.resolve();await gate.promise;throw boom});return {};
 }});
 const rootEntry=d.entry('root',{}),childEntry=d.entry('child',{requires:{s:S}});
 holder.runtime=createRuntime({services:[S],limits:{disposalGraceMs:1000}});
 holder.root=await holder.runtime.enter(rootEntry);holder.child=await holder.root.enter(childEntry);await holder.child.deps.s.load();
 const outer=holder[spec.outer].dispose();outer.then(()=>outerState='fulfilled',()=>outerState='rejected');
 await entered.promise;await turn();await turn();
 const before={innerState,outerState,childState:holder.child.state,rootState:holder.root.state,cleanups,starts};
 assert.equal(innerState,'pending',`${spec.name}: inner ended early`);assert.equal(outerState,'pending');assert.equal(before.childState,'disposing');assert.equal(starts,0);assert.equal(await loadResult,'ENV_CLOSED');
 gate.resolve();const [a,b]=await Promise.allSettled([outer,inner]);
 assert.equal(a.status,'rejected');assert.equal(b.status,'rejected');
 assert.equal(flat(a.reason).filter(e=>e===boom).length,1);assert.equal(flat(b.reason).filter(e=>e===boom).length,1);assert.equal(cleanups,1);
 results.push({name:spec.name,status:'PASS',before,statesAtListener:states,outcomes:[a.status,b.status],sameReason:a.reason===b.reason,cleanupCalls:cleanups});
 await holder.runtime.dispose().catch(()=>{});
}
// A real diagnostic must be emitted before testing reentry from its callback.
{
 const d=definePackage({name:'@review/event-reentry',version:'1.0.0'});const gate=deferred();let env,inner,calls=0;const error=Error('first cleanup');
 const s=d.service({setup(_,{onDispose}){onDispose(()=>gate.promise);onDispose(()=>{throw error});return {}}});const e=d.entry({requires:{s}});
 const r=createRuntime({services:[s],limits:{disposalGraceMs:25},diagnostics:{onEvent(event){if(event.type==='attempt-abandoned'){calls++;inner=env.dispose();void inner.catch(()=>{})}}}});
 env=await r.enter(e);await env.deps.s.load();let outerError;try{await env.dispose()}catch(e){outerError=e};let innerError;try{await inner}catch(e){innerError=e};
 assert.equal(calls,1);assert.strictEqual(innerError,outerError);assert.equal(flat(innerError).filter(e=>e===error).length,1);gate.resolve();await sleep(5);await r.dispose().catch(()=>{});
 results.push({name:'actual-onEvent-reentry',status:'PASS',calls,bothObserveSameError:true});
}
// Demonstrate that the repository's benign-service onEvent test never enters its callback.
{
 const d=definePackage({name:'@review/benign-onEvent-control',version:'1.0.0'});let calls=0;const s=d.service({setup(_,{onDispose}){onDispose(()=>{});return{}}});const e=d.entry({requires:{s}});const r=createRuntime({services:[s],diagnostics:{onEvent(){calls++}}});const env=await r.enter(e);await env.deps.s.load();await env.dispose();await r.dispose();assert.equal(calls,0);results.push({name:'benign-onEvent-control',status:'OBSERVED',callbackCalls:calls});
}
await writeFile(process.env.OUT??new URL('../evidence/close-guards.json',import.meta.url),JSON.stringify({node:process.version,target,results},null,2)+'\n');
console.log(JSON.stringify(results,null,2));
