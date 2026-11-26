"""Add a checked pack to index.html as a new 'question pack' block.
Usage: python3 tools/questions/inject_pack.py filtered.json "short description"   (run from the repo root)"""
import json, sys, re
P=json.load(open(sys.argv[1])); desc=sys.argv[2] if len(sys.argv)>2 else "weekly pack"
s=open("index.html").read()
nums=[int(n) for n in re.findall(r"/\* question pack (\d+)",s)]; n=max(nums or [29])+1
js=json.dumps(P,ensure_ascii=False,separators=(",",":")).replace("</","<\\/")
block=f"""/* question pack {n}: {desc} */
(function(){{ const P={js};
  const nq=t=>NEWQ.add(norm(String(t)));
  for(const k of ["gk_pop","gk","gk_hard","est_pop","est","est_hard","rank_pop","rank","pin","pin_pop","pin_hard","uniq"]) (P[k]||[]).forEach(x=>{{ nq(x[0]); (BANK[k]||(BANK[k]=[])).push(x); }});
  (P.mf||[]).forEach(x=>{{ nq(x[1]); BANK.mf.push(x); }});
  for(const t in (P.sp||{{}})) P.sp[t].forEach(x=>{{ nq(x[0]); (SP_BANK[t]||(SP_BANK[t]=[])).push(x); }});
  for(const f in (P.hl||{{}})) if(HL_BANK[f]) P.hl[f].forEach(x=>{{ nq(x[0]); HL_BANK[f].items.push(x); }});
}})();
"""
anchor="/* ---------- questions built from data"
assert s.count(anchor)==1, "anchor missing"
s=s.replace(anchor,block+anchor); open("index.html","w").write(s)
print("added question pack",n)
