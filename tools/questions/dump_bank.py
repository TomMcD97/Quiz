"""Dump every question currently in the game to existing.json (for duplicate checks).
Usage: python3 tools/questions/dump_bank.py   (run from the repo root; needs Playwright + Chrome)"""
import json, subprocess, time, os, sys
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),"existing.json")
env=dict(os.environ, PORT="5099")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
    time.sleep(2)
    exe=next((p for p in ["/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser"] if os.path.exists(p)),None)
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path=exe,args=["--no-sandbox"]) if exe else p.chromium.launch()
        pg=b.new_page(); pg.goto("http://localhost:5099/",wait_until="load"); pg.wait_for_timeout(2000)
        d=pg.evaluate("""()=>{ const strip=a=>a.filter(x=>!x.key); const B={}; for(const k in BANK) B[k]=Array.isArray(BANK[k])?strip(BANK[k]):BANK[k];
          const H={}; for(const f in HL_BANK) if(!HL_BANK[f].gen) H[f]=HL_BANK[f]; return {BANK:B, SP_BANK, HL_BANK:H}; }""")
        b.close()
    json.dump(d,open(OUT,"w"),ensure_ascii=False)
    n=sum(len(v) for v in d["BANK"].values() if isinstance(v,list))+sum(len(v) for v in d["SP_BANK"].values())+sum(len(v["items"]) for v in d["HL_BANK"].values())
    print("wrote",OUT,"-",n,"items")
finally:
    srv.terminate()
