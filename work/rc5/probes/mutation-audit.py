from pathlib import Path
import shutil, subprocess, json, re, difflib, os
ROOT=Path(__file__).resolve().parents[1]
BASE=Path(os.environ.get('SYNA_ROOT', str(ROOT/'source'))).resolve()
results=[]
for name in ['join-premature','deadline-4x']:
    tree=ROOT/'mutations'/name
    core=tree/'packages/core'
    (core/'tests').mkdir(parents=True,exist_ok=True)
    shutil.copytree(BASE/'packages/core/dist',core/'dist',dirs_exist_ok=True)
    shutil.copy2(BASE/'packages/core/package.json',core/'package.json')
    for p in (BASE/'packages/core/tests').glob('rc4-*.test.mjs'): shutil.copy2(p,core/'tests'/p.name)
    (tree/'node_modules').mkdir(exist_ok=True)
    sem=tree/'node_modules/semver'
    if not sem.exists(): sem.symlink_to(BASE/'node_modules/semver',target_is_directory=True)
    if name=='join-premature':
        f=core/'dist/runtime.js';old=f.read_text();assert old.count('await this.disposePromise;')==2
        new=old.replace('await this.disposePromise;', 'return; // MUTANT: reentrant observer fulfils instead of joining the close')
        files=sorted((core/'tests').glob('rc4-*.test.mjs'))
        explanation='Both joinClose methods yield once then fulfil; real close remains intact. Tests must assert INNER observer outcome to reject this.'
    else:
        f=core/'dist/internal/materializer.js';old=f.read_text();target='deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs));';assert old.count(target)==1
        new=old.replace(target,'deadlines.add(waiter, performance.now() + Math.max(0, deadlineMs * 4)); // MUTANT: fourfold timeout')
        files=[core/'tests/rc4-waiter-termination.test.mjs']
        explanation='Every attempt deadline is armed for four times its configured timeout; reported timeout details unchanged.'
    f.write_text(new)
    patch=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='ORIGINAL/'+str(f.relative_to(tree)),tofile='MUTANT/'+str(f.relative_to(tree))))
    (ROOT/'evidence'/f'mutant-{name}.patch').write_text(patch)
    cmd=['node','--test','--test-reporter=tap',*[str(p.relative_to(tree)) for p in files]]
    run=subprocess.run(cmd,cwd=tree,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=35)
    (ROOT/'evidence'/f'mutant-{name}.log').write_text(run.stdout)
    counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped) (\d+)$',run.stdout,re.M)}
    result={'name':name,'explanation':explanation,'command':cmd,'exit':run.returncode,'counts':counts,'testFiles':[p.name for p in files],'scope':'scratch compiled copy only; originals untouched'}
    results.append(result);print(json.dumps(result))
(ROOT/'evidence/mutation-results.json').write_text(json.dumps(results,indent=2)+'\n')
