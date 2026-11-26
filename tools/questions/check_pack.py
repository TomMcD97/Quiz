"""Check a candidate pack against everything already in the game and drop duplicates and malformed items.
Usage: python3 tools/questions/check_pack.py candidate.json filtered.json
Pack format (any key may be missing):
  gk / gk_pop / gk_hard : [question, right, wrong, wrong, wrong]
  est / est_pop / est_hard : [question, number, unit]
  pin / pin_pop / pin_hard : [place, lat, lng]
  rank / rank_pop : [prompt, [5 items in order], [5 values], lowLabel, highLabel]
  uniq : [prompt, [many valid answers]]       (needs at least 12 answers)
  mf : [category, title, [right picks], [traps]] (8 right + 4 traps is the usual shape)
  hl : {family: [[label, number], ...]}  families: count, money, height(m), length(km), age, year
  sp : {topic: [gk-style items]}   topic must already exist in SP_BANK"""
import json, re, sys, os
HERE=os.path.dirname(os.path.abspath(__file__))
E=json.load(open(os.path.join(HERE,"existing.json")))
STOP=set("the a an of in on to which what who is was for and by with as at from its it this that how many name did does do be are were known first".split())
def words(t): return set(w for w in re.findall(r"[a-z0-9']+",str(t).lower()) if w not in STOP and len(w)>2)
def norm(t): return re.sub(r"[^a-z0-9]","",str(t).lower())
ex=[]
for k,v in E["BANK"].items():
    if isinstance(v,list):
        for x in v: ex.append((k,x))
for t,v in E["SP_BANK"].items():
    for x in v: ex.append(("sp",x))
def qa(k,x):
    if k=="mf": return x[1],""
    if len(x)>1 and isinstance(x[1],(str,int,float)): return x[0],x[1]
    return x[0],""
EXN=set(norm(qa(k,x)[0]) for k,x in ex)
EXW=[(words(qa(k,x)[0]),norm(qa(k,x)[1])) for k,x in ex]
PINS=[x for k,x in ex if k.startswith("pin")]
seenN=set(); seenW=[]
def similar(w,na,pool): return any(na and na==ea and len(w&ew)>=2 and len(w&ew)/max(1,min(len(w),len(ew)))>=0.6 for ew,ea in pool)
def ok_item(kind,x):
    q=x[0]; a=x[1] if kind in("gk","est","sp") else ""
    if kind in("gk","sp"):
        if len(x)!=5 or len(set(map(norm,x[1:])))!=4: return "bad shape"
    if kind=="est" and not (len(x)==3 and isinstance(x[1],(int,float)) and isinstance(x[2],str)): return "bad shape"
    if kind=="pin":
        if not (len(x)==3 and -90<=x[1]<=90 and -180<=x[2]<=180): return "bad shape"
        if any(norm(y[0].split(",")[0])==norm(q.split(",")[0]) or (abs(y[1]-x[1])<0.03 and abs(y[2]-x[2])<0.03) for y in PINS): return "duplicate place"
    if kind=="rank" and not (len(x)==5 and len(x[1])==5 and len(x[2])==5): return "bad shape"
    if kind=="uniq" and not (len(x)==2 and len(set(map(norm,x[1])))>=12): return "needs 12+ answers"
    if kind=="mf" and not (len(x)==4 and len(x[2])+len(x[3])>=10 and not set(map(norm,x[2]))&set(map(norm,x[3]))): return "bad shape"
    n=norm(x[1] if kind=="mf" else q)
    if n in EXN or n in seenN: return "duplicate"
    w=words(x[1] if kind=="mf" else q); na=norm(a)
    if similar(w,na,EXW) or similar(w,na,seenW): return "same question, reworded"
    seenN.add(n); seenW.append((w,na)); return None
src=json.load(open(sys.argv[1])); out={}; report=[]
for key,items in src.items():
    if key=="hl":
        out["hl"]={}
        for f,L in items.items():
            if f not in E["HL_BANK"]: report.append(f"hl family {f} doesn't exist"); continue
            have=set(norm(x[0]) for x in E["HL_BANK"][f]["items"])
            keep=[x for x in L if len(x)==2 and isinstance(x[1],(int,float)) and norm(x[0]) not in have]
            out["hl"][f]=keep; report.append(f"hl.{f}: {len(L)} -> {len(keep)}")
        continue
    if key=="sp":
        out["sp"]={}
        for t,L in items.items():
            if t not in E["SP_BANK"]: report.append(f"sp topic {t} doesn't exist"); continue
            keep=[x for x in L if ok_item("sp",x) is None]; out["sp"][t]=keep; report.append(f"sp.{t}: {len(L)} -> {len(keep)}")
        continue
    kind=re.sub(r"_(pop|hard)$","",key); keep=[]
    for x in items:
        why=ok_item(kind,x)
        if why: report.append(f"  drop [{key}] {why}: {x[1] if kind=='mf' else x[0]}")
        else: keep.append(x)
    out[key]=keep; report.append(f"{key}: {len(items)} -> {len(keep)}")
json.dump(out,open(sys.argv[2],"w"),ensure_ascii=False)
print("\n".join(report))
tot=sum(len(v) if isinstance(v,list) else sum(len(z) for z in v.values()) for v in out.values()); print("KEPT",tot)
