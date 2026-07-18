/** ═══════════════════════════════════════════════════════════════════════════
 *  EVENSHIFT FOR GOOGLE SHEETS — Stage 2 (full edition)
 *
 *  Paste this whole file into Extensions → Apps Script (replacing what's
 *  there), hit Save, reload the spreadsheet, then run
 *  EvenShift → ⚙️ Set up sheets. Upgrading from Stage 1? Same steps — your
 *  Rules values and Staff list are kept. Full guide: SETUP.md in the repo.
 *
 *  Stage 1: checkbox scoring · the real EvenShift engine (acuity hours ▸
 *    safety caps ▸ hallway grouping ▸ burden mix ▸ handoff, with total-swap
 *    first) · live rule warnings on hand-edited Nurse cells · End Shift
 *  Stage 2 adds: PCT zones · 1:1 sitter coverage · break requests with slot
 *    caps + charge approval · Vocera · code blue team · break buddies ·
 *    DRAFT/POSTED status · Quick hits with read-receipts · History tab ·
 *    big acuity-swing alerts
 *
 *  Everything runs inside your Google Workspace. No external services.
 *  Room numbers only — no patient names.
 *  ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── Tab & column layout ─────────────────────────────
 * Scores : A Room | B Suggested | C Acuity | D Next Shift | E Flags | F Nurse
 *          | G.. one checkbox column per quick factor (row 2 holds the points)
 * Staff  : A Name | B Role (RN/PCT/Sitter/HUC) | C Level | D On today
 *          | E Vocera | F 1:1 Room (sitters) | G Break slot | H Break OK
 * Floor  : A Room | B Hall (1-4) | C Position from station (0 = closest)
 * Rules  : settings block + flag-rules table (all editable)
 * Board  : generated output (do not type here) — row 3 is the DRAFT/POSTED banner
 * Quick hits : message + read-receipts
 * History: one row per shift, appended by End Shift
 * Previous : written by End Shift (do not type here)
 * ─────────────────────────────────────────────────────────────────────────── */

var SCORES='Scores', STAFF='Staff', FLOOR='Floor', RULES='Rules', BOARD='Board', PREV='Previous', QUICK='Quick hits', HIST='History';

/* Quick scoring factors: [label, points, flag-code-it-implies-or-null] */
var FACTORS = [
  ['Routine meds / assessment', 1, null],
  ['4+ PRN meds', 1, null],
  ['Q2 PRN pain meds', 1, null],
  ['Heparin drip', 1, 'hep'],
  ['Insulin drip', 2, 'ins'],
  ['Telemetry / pulse ox', 0.5, 'tele'],
  ['Q4–6H glucose checks', 1, null],
  ['O2 2–4L', 0.5, null],
  ['Tube feeding / TPN', 0.5, 'dht'],
  ['Foley / ext cath', 1, 'foley'],
  ['Behavioral / difficult family', 1, 'beh'],
  ['Confused', 1, 'conf'],
  ['Fall risk', 1, 'conf'],
  ['Turn Q2', 1, null],
  ['Wound care / vac', 0.5, 'wound']
];

/* Flag legend: [code, label]. Type either the code or the label in the Flags cell. */
var FLAGS = [
  ['iso','Isolation'],['airb','Airborne'],['dc','Discharge'],['adm','Admit'],['beh','Behavioral'],
  ['conf','Confused / fall risk'],['sit','1:1 sitter'],['trach','Trach'],['gtt','IV drip'],
  ['hep','Heparin drip'],['ins','Insulin drip'],['cvl','Central line'],['picc','PICC'],
  ['hd','Hemodialysis'],['foley','Foley'],['tot','Total care'],['wound','Wound care'],
  ['restr','Restraints'],['chest','Chest tube'],['dnar','DNAR'],['tele','Telemetry'],['dht','Tube feed']
];

var DEFAULT_FLAG_RULES = [
  ['beh','cap',1],['ins','ratiocap',3],['cvl','spread',''],['trach','cap',1],['tot','spread',''],
  ['sit','spread',''],['conf','spread',''],['dc','spread',''],['adm','spread','']
];

var BURDEN_W = { beh:4, conf:4, trach:4, airb:4, tot:3, sit:3, chest:3, restr:3, dc:3, hd:2.5,
  adm:2, cvl:1.5, picc:1.5, gtt:2, hep:2, ins:2, wound:2, iso:1.5, foley:1, dht:1, hi:0 };

/* 10 Green default floor — replace on the Floor tab for your unit. [room, hall, position] */
var DEFAULT_FLOOR = (function(){
  var halls = { 1:[49,47,45,43,41,39,37,35,33], 2:[46,44,42,40,38,36,34], 3:[51,53,55,57,59,61,63,65], 4:[50,52,54,56,58,60,62,64] };
  var out = [];
  [1,2,3,4].forEach(function(h){ halls[h].forEach(function(rn,i){ out.push([rn,h,i]); }); });
  return out;
})();

/* 30-minute break slots for both shifts (Day 10:30a–4:30p starts, Night 10:30p–4:30a starts). */
var BREAK_SLOTS=(function(){
  var mk=function(startH,startM,count,pm){
    var out=[], h=startH, m=startM;
    for(var i=0;i<count;i++){
      var lab=((h%12)||12)+':'+(m<10?'0':'')+m+((h%24)<12?'a':'p');
      out.push(lab);
      m+=30; if(m>=60){ m=0; h=(h+1)%24; }
    }
    return out;
  };
  return mk(10,30,13).concat(mk(22,30,13));
})();

/* ═════════════════════════ ENGINE START ════════════════════════════════════
 * Pure JavaScript — no Sheets calls. Ported from the EvenShift web app so the
 * Sheet and the app follow the SAME rules. Tested headless in Node.
 * ═══════════════════════════════════════════════════════════════════════════ */

function esWing(room){ return (room.hall===1||room.hall===2) ? 'L' : 'R'; }

function esRoomDist(a,b){
  if(a.hall===b.hall) return Math.abs(a.pos-b.pos);
  var base=a.pos+b.pos;
  return base + (esWing(a)===esWing(b) ? 2 : 6);
}

function esGroupGeo(g){
  var s=0,i,j;
  for(i=0;i<g.length;i++) for(j=i+1;j<g.length;j++) s+=esRoomDist(g[i],g[j]);
  var halls={}, wings={};
  g.forEach(function(r){ halls[r.hall]=Math.max(halls[r.hall]||0,r.pos); wings[esWing(r)]=1; });
  var hallKeys=Object.keys(halls), extra=(hallKeys.length-1)*10 + (Object.keys(wings).length-1)*90;
  if(hallKeys.length>1){
    var depths=hallKeys.map(function(h){ return halls[h]; }).sort(function(x,y){ return x-y; });
    for(var k=0;k<depths.length-1;k++) extra+=depths[k]*6;
  }
  return s+extra;
}

function esEligible(n,r,cfg){
  if(n.level==='Orienting' && (r.acuity>=cfg.heavyAt || r.flags.indexOf('beh')>=0)) return false;
  if(n.level==='Float' && (r.acuity>=cfg.heavyAt || r.flags.indexOf('beh')>=0 || r.flags.indexOf('sit')>=0)) return false;
  return true;
}

function esGenerate(rooms, nurses, prev, cfg){
  var occ=rooms.filter(function(r){ return r.acuity>0; });
  var M=nurses.length, N=occ.length;
  var out={assign:{}, spread:0, swap:null, handoff:[], violations:[]};
  if(!M||!N) return out;

  var hrs=function(g){ return g.reduce(function(s,r){ return s+r.acuity; },0); };
  var G=[];
  var spread=function(){ var h=G.map(hrs); return Math.max.apply(null,h)-Math.min.apply(null,h); };
  var geo=function(){ return G.reduce(function(s,g){ return s+esGroupGeo(g); },0); };
  var BW=cfg.burdenW||BURDEN_W;
  var tags=function(r){ var t=r.flags.slice(); if(r.acuity>=cfg.heavyAt-1) t.push('hi'); return t; };
  var burden=function(){ var c=0; G.forEach(function(g){ var cnt={}; g.forEach(function(r){ tags(r).forEach(function(t){ if(BW[t]) cnt[t]=(cnt[t]||0)+1; }); }); for(var t in cnt) c+=BW[t]*cnt[t]*cnt[t]; }); return c; };

  var totHeavy=occ.filter(function(r){ return r.acuity>=cfg.heavyAt; }).length;
  var totBeh=occ.filter(function(r){ return r.flags.indexOf('beh')>=0; }).length;
  var totConf=occ.filter(function(r){ return r.flags.indexOf('conf')>=0; }).length;
  var capHeavy=Math.max(1,Math.ceil(totHeavy/M)), capBeh=Math.max(1,Math.ceil(totBeh/M)), capConf=Math.max(1,Math.ceil(totConf/M));
  var safety=function(){ var c=0; G.forEach(function(g){ var h=0,b=0,cf=0,dc=0,adm=0;
      g.forEach(function(r){ if(r.acuity>=cfg.heavyAt)h++; var f=r.flags;
        if(f.indexOf('beh')>=0)b++; if(f.indexOf('conf')>=0)cf++; if(f.indexOf('dc')>=0)dc++; if(f.indexOf('adm')>=0)adm++; });
      if(h>capHeavy)c+=(h-capHeavy)*85; if(b>capBeh)c+=(b-capBeh)*100; if(cf>capConf)c+=(cf-capConf)*55;
      if(cfg.avoidDcAdm && dc>0 && adm>0) c+=Math.min(dc,adm)*40; });
    return c; };

  var FR=cfg.flagRules||{};
  var hasFlag=function(r,code){ return r.flags.indexOf(code)>=0; };
  var groupRatioCap=function(g){ var cap=cfg.ratio;
    g.forEach(function(r){ for(var code in FR){ if(FR[code].mode==='ratiocap' && hasFlag(r,code)) cap=Math.min(cap,Math.max(1,FR[code].value||cfg.ratio)); } });
    return cap; };
  var flagRuleCost=function(){ var c=0;
    for(var code in FR){ var rule=FR[code]; if(rule.mode!=='cap'&&rule.mode!=='spread') continue;
      var total=occ.filter(function(r){ return hasFlag(r,code); }).length; if(!total) continue;
      var lim=rule.mode==='cap'?Math.max(1,rule.value||1):Math.ceil(total/M);
      G.forEach(function(g){ var k=g.filter(function(r){ return hasFlag(r,code); }).length;
        if(k>lim) c+=rule.mode==='cap'?(k-lim)*120:(k-lim)*(k-lim)*30; }); }
    G.forEach(function(g){ var cap=groupRatioCap(g); if(g.length>cap) c+=(g.length-cap)*(g.length-cap)*1200; });
    return c; };
  var hardCapsOK=function(){
    for(var code in FR){ if(FR[code].mode!=='cap') continue; var lim=Math.max(1,FR[code].value||1);
      for(var gi=0;gi<G.length;gi++){ if(G[gi].filter(function(r){ return hasFlag(r,code); }).length>lim) return false; } }
    for(var gj=0;gj<G.length;gj++){ if(G[gj].length>groupRatioCap(G[gj])) return false; }
    return true; };

  var prevOwner={};
  (prev||[]).forEach(function(rec){ (rec.rooms||[]).forEach(function(rn){ prevOwner[rn]=rec.name; }); });
  var hasHandoff=Object.keys(prevOwner).length>0;
  var handoff=function(){ if(!hasHandoff) return 0; var byPrev={};
    G.forEach(function(g,gi){ g.forEach(function(r){ var pv=prevOwner[r.id]; if(pv==null) return; (byPrev[pv]=byPrev[pv]||{})[gi]=1; }); });
    var c=0; for(var pv in byPrev) c+=Object.keys(byPrev[pv]).length-1; return c; };
  var HANDOFF_W=cfg.handoffW!=null?cfg.handoffW:6;

  var cost=function(){ return Math.max(0,spread()-cfg.targetSpread)*450 + safety() + geo() + 2*burden() + HANDOFF_W*handoff() + flagRuleCost(); };

  /* ── TOTAL SWAP FIRST: hand each outgoing nurse's whole group to one oncoming nurse ── */
  var ids=null;
  if(cfg.swapFirst && hasHandoff){
    var byId={}; occ.forEach(function(r){ byId[r.id]=r; });
    var groups=(prev||[]).map(function(rec){ return {prevName:rec.name, rooms:(rec.rooms||[]).map(function(rn){ return byId[rn]; }).filter(Boolean)}; })
      .filter(function(g){ return g.rooms.length; });
    if(groups.length && groups.length<=M){
      while(groups.length<M) groups.push({prevName:null, rooms:[]});
      var inG={}; groups.forEach(function(g){ g.rooms.forEach(function(r){ inG[r.id]=1; }); });
      var leftovers=occ.filter(function(r){ return !inG[r.id]; });
      var gOK=function(n,gi){ for(var k=0;k<groups[gi].rooms.length;k++){ if(!esEligible(n,groups[gi].rooms[k],cfg)) return false; } return true; };
      var sIds=new Array(M).fill(null), used={};
      var bt=function(gi){ if(gi>=M) return true;
        var own=-1; nurses.forEach(function(n,i){ if(n.name===groups[gi].prevName) own=i; });
        var cands=[]; nurses.forEach(function(n,i){ if(!used[i]&&gOK(n,gi)) cands.push(i); });
        cands.sort(function(a,b){ return (a===own?0:1)-(b===own?0:1); });
        for(var c=0;c<cands.length;c++){ var ni=cands[c]; used[ni]=1; sIds[gi]=nurses[ni].name;
          if(bt(gi+1)) return true; delete used[ni]; sIds[gi]=null; }
        return false; };
      if(bt(0)){
        var ok=true;
        leftovers.forEach(function(r){ if(!ok) return; var best=-1,bh=Infinity;
          for(var gi=0;gi<M;gi++){ var n=null; nurses.forEach(function(x){ if(x.name===sIds[gi]) n=x; });
            if(!n||!esEligible(n,r,cfg)) continue; var h=hrs(groups[gi].rooms); if(h<bh){bh=h;best=gi;} }
          if(best<0){ ok=false; return; } groups[best].rooms.push(r); });
        if(ok){
          G=groups.map(function(g){ return g.rooms.slice(); });
          var sp=spread();
          if(sp<=(cfg.swapTol!=null?cfg.swapTol:cfg.targetSpread)+1e-9 && safety()===0 && hardCapsOK()){
            ids=sIds; out.swap={ok:true, spread:sp};
          } else out.swap={ok:false, reason:'hours', spread:sp};
        } else out.swap={ok:false, reason:'staffing'};
      } else out.swap={ok:false, reason:'staffing'};
    } else out.swap={ok:false, reason:'staffing'};
  }

  /* ── Fresh build: seed by hall order, then annealing ── */
  if(!ids){
    var order=occ.slice().sort(function(a,b){ return (a.hall-b.hall)||(a.pos-b.pos); });
    G=[]; for(var s0=0;s0<M;s0++) G.push([]);
    var targets=[]; { var b0=Math.floor(N/M), rm=N%M; for(var s1=0;s1<M;s1++) targets.push(b0+(s1<rm?1:0)); }
    order.forEach(function(r){ var pick=-1,bestKey=Infinity;
      for(var s=0;s<M;s++){ if(G[s].length>=targets[s]) continue; var load=hrs(G[s]); if(load<bestKey){bestKey=load;pick=s;} }
      if(pick<0){ for(var s2=0;s2<M;s2++){ var l2=hrs(G[s2]); if(l2<bestKey){bestKey=l2;pick=s2;} } }
      G[pick].push(r); });
    var bestC=Infinity, best=G.map(function(g){ return g.slice(); });
    for(var pass=0; pass<4; pass++){
      if(pass>0){ var pool=[]; G.forEach(function(g){ while(g.length){ pool.push(g.pop()); } });
        for(var k1=pool.length-1;k1>0;k1--){ var q=Math.floor(Math.random()*(k1+1)); var tmp=pool[k1]; pool[k1]=pool[q]; pool[q]=tmp; }
        pool.forEach(function(r){ var sm=0; for(var x=1;x<M;x++) if(G[x].length<G[sm].length) sm=x; G[sm].push(r); }); }
      var cur=cost(), passBestC=cur, passBest=G.map(function(g){ return g.slice(); }), T=8;
      for(var it=0; it<20000; it++){
        T*=0.99975;
        var i=Math.floor(Math.random()*M), j=Math.floor(Math.random()*M); if(i===j) continue;
        var gi2=G[i], gj2=G[j]; if(!gi2.length||!gj2.length) continue;
        var a=Math.floor(Math.random()*gi2.length), b=Math.floor(Math.random()*gj2.length);
        var ra=gi2[a], rb=gj2[b]; gi2[a]=rb; gj2[b]=ra;
        var c2=cost(), d=c2-cur;
        if(d<0 || Math.random()<Math.exp(-d/T)){ cur=c2; if(c2<passBestC-1e-9){ passBestC=c2; passBest=G.map(function(g){ return g.slice(); }); } }
        else { gi2[a]=ra; gj2[b]=rb; }
      }
      if(passBestC<bestC){ bestC=passBestC; best=passBest; }
      G=passBest.map(function(g){ return g.slice(); });
    }
    G=best;
    var canTake=function(n,gi){ for(var k=0;k<G[gi].length;k++){ if(!esEligible(n,G[gi][k],cfg)) return false; } return true; };
    var gPrev=G.map(function(g){ var tally={},bn=0,bestN=null;
      g.forEach(function(r){ var pv=prevOwner[r.id]; if(pv==null) return; tally[pv]=(tally[pv]||0)+1; if(tally[pv]>bn){bn=tally[pv];bestN=pv;} });
      return bestN; });
    var mIds=new Array(M).fill(null);
    var sorted=nurses.map(function(n,i){ return i; }).sort(function(a,b){
      var ra2=(nurses[a].level==='Orienting'||nurses[a].level==='Float')?0:1;
      var rb2=(nurses[b].level==='Orienting'||nurses[b].level==='Float')?0:1; return ra2-rb2; });
    var ordNurses=sorted.map(function(i){ return nurses[i]; });
    var mbt=function(oi){ if(oi>=M) return true; var n=ordNurses[oi];
      var cands=[]; for(var gi=0;gi<M;gi++) if(mIds[gi]==null && canTake(n,gi)) cands.push(gi);
      cands.sort(function(x,y){ return (gPrev[y]===n.name?1:0)-(gPrev[x]===n.name?1:0); });
      for(var c=0;c<cands.length;c++){ var gi3=cands[c]; mIds[gi3]=n.name;
        if(mbt(oi+1)) return true; mIds[gi3]=null; }
      return false; };
    if(!mbt(0)){ mIds=G.map(function(g,gi){ return nurses[gi%M].name; }); }
    ids=mIds;
  }

  G.forEach(function(g,gi){ g.forEach(function(r){ out.assign[r.id]=ids[gi]; }); });
  out.spread=Math.round(spread()*100)/100;

  if(hasHandoff){
    (prev||[]).forEach(function(rec){ var tally={};
      (rec.rooms||[]).forEach(function(rn){ var nm=out.assign[rn]; if(!nm) return; tally[nm]=(tally[nm]||0)+1; });
      var to=Object.keys(tally).map(function(nm){ return {name:nm,n:tally[nm]}; }).sort(function(a,b){ return b.n-a.n; });
      if(to.length) out.handoff.push({from:rec.name, to:to}); });
  }

  G.forEach(function(g,gi){
    var b=g.filter(function(r){ return r.flags.indexOf('beh')>=0; }).length;
    var h=g.filter(function(r){ return r.acuity>=cfg.heavyAt; }).length;
    if(b>capBeh) out.violations.push(ids[gi]+' has '+b+' behavioral patients (aim '+capBeh+')');
    if(h>capHeavy) out.violations.push(ids[gi]+' has '+h+' heavy ('+cfg.heavyAt+'+) patients (aim '+capHeavy+')');
    var cap=groupRatioCap(g); if(g.length>cap) out.violations.push(ids[gi]+' has '+g.length+' patients but a flag limits them to '+cap);
  });
  return out;
}

/* ── Stage 2 pure helpers (also tested headless) ─────────────────────────── */

/* Walk order of the whole floor: outer-left in, center-left in, center-right out, outer-right out. */
function esWalkPos(rooms){
  var h={};
  rooms.forEach(function(r){ (h[r.hall]=h[r.hall]||[]).push(r); });
  [1,2,3,4].forEach(function(k){ (h[k]=h[k]||[]).sort(function(a,b){ return a.pos-b.pos; }); });
  var walk=h[2].slice().reverse().concat(h[1].slice().reverse(), h[3], h[4]);
  var m={}; walk.forEach(function(r,i){ m[r.id]=i; });
  return m;
}

/* Split an ordered list into k contiguous near-even chunks (for PCT zones). */
function esContigChunks(list,k){
  if(k<=0) return [];
  var n=list.length, base=Math.floor(n/k), rem=n%k, out=[], idx=0;
  for(var i=0;i<k;i++){ var take=base+(i<rem?1:0); out.push(list.slice(idx,idx+take)); idx+=take; }
  return out;
}

/* Pair names into physically-adjacent break buddies: sort by median walk position, pair 2s (3 for an odd tail). */
function esBuddyPairs(names, medPos){
  var ordered=names.slice().sort(function(a,b){ return (medPos[a]||0)-(medPos[b]||0); });
  var pairs=[], i=0;
  while(i<ordered.length){ var left=ordered.length-i;
    if(left===3){ pairs.push(ordered.slice(i,i+3)); i+=3; }
    else if(left===1){ if(pairs.length) pairs[pairs.length-1].push(ordered[i]); else pairs.push([ordered[i]]); i+=1; }
    else { pairs.push(ordered.slice(i,i+2)); i+=2; } }
  return pairs;
}

/* Code blue team from the crew: seniors lead & push meds, orientee records, PCTs on compressions/runner. */
function esCodeTeam(rns, pctNames){
  var rank={Senior:2,RN:1,Float:1,Orienting:0};
  var pool=rns.slice().sort(function(a,b){ return (rank[b.level]||1)-(rank[a.level]||1); });
  var usedN={}, usedP={};
  var takeRN=function(pref){
    var c=pool.filter(function(n){ return !usedN[n.name]; });
    if(pref){ var p=c.filter(function(n){ return n.level===pref; })[0]; if(p){ usedN[p.name]=1; return p.name; } }
    if(c[0]){ usedN[c[0].name]=1; return c[0].name; } return null; };
  var takePCT=function(){ var p=(pctNames||[]).filter(function(x){ return !usedP[x]; })[0]; if(p){ usedP[p]=1; return p; } return null; };
  /* fill in PRIORITY order (like the app) so both seniors land on leader + meds before airway takes one */
  var leader=takeRN('Senior'), meds=takeRN('Senior'), airway=takeRN(),
      recorder=takeRN('Orienting'), comp1=takePCT()||takeRN(),
      runner=takePCT()||takeRN(), comp2=takePCT()||takeRN();
  return [
    {role:'Code leader',        who:leader,   hint:'runs the code'},
    {role:'Compressions',       who:comp1,    hint:'CPR, swap q2min'},
    {role:'Airway / BVM',       who:airway,   hint:'bag + suction'},
    {role:'Meds / push',        who:meds,     hint:'ACLS drugs'},
    {role:'Recorder',           who:recorder, hint:'times & documents'},
    {role:'Crash cart / runner',who:runner,   hint:'cart & supplies'},
    {role:'Backup compressions',who:comp2,    hint:'relieves CPR'}
  ];
}

/* Staggered 30-min sitter break windows from shift start; PCTs cover round-robin, else Charge. */
function esSitterCoverage(sitters, pctNames, shift){
  var startH = shift==='Night' ? 23 : 11;
  var fmt=function(h,m){ return ((h%12)||12)+':'+(m<10?'0':'')+m+((h%24)<12?'a':'p'); };
  return sitters.map(function(s,i){
    var mins=startH*60 + i*30, h=Math.floor(mins/60)%24, m=mins%60;
    var mins2=mins+30, h2=Math.floor(mins2/60)%24, m2=mins2%60;
    var cover=(pctNames&&pctNames.length)?pctNames[i%pctNames.length]:'Charge';
    return {sitter:s.name, room:s.room, window:fmt(h,m)+'–'+fmt(h2,m2), cover:cover};
  });
}
/* ═════════════════════════ ENGINE END ══════════════════════════════════════ */

/* ─────────────────────────── Sheets wiring ──────────────────────────────── */

function onOpen(){
  SpreadsheetApp.getUi().createMenu('EvenShift')
    .addItem('✨ Make Assignment','makeAssignment')
    .addItem('📌 Post / unpost the board','togglePosted')
    .addItem('🔄 End Shift & Hand Off','endShift')
    .addItem('🧹 Clear Board','clearBoard')
    .addSeparator()
    .addItem('⚙️ Set up sheets (first run / repair / upgrade)','setupSheets')
    .addToUi();
}

function _ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function _sheet(name){ var s=_ss().getSheetByName(name); if(!s) s=_ss().insertSheet(name); return s; }
function _colLetter(n){ var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); } return s; }
function _props(){ return PropertiesService.getDocumentProperties(); }

function setupSheets(){
  var ss=_ss();

  /* Rules — preserve any values the unit already customized (matched by label / flag code) */
  var ru=_sheet(RULES);
  var old={};
  try{ var lr=ru.getLastRow();
    if(lr>2) ru.getRange(1,1,lr,3).getValues().forEach(function(r){ if(r[0]!=='' && r[1]!=='') old[String(r[0])]=[r[1],r[2]]; });
  }catch(e){}
  ru.clear();
  ru.getRange(1,1,1,2).setValues([['EvenShift rules — every value here is editable','']]).setFontWeight('bold');
  var settings=[
    ['Target evenness (hrs)',0.5,'Assignment aims for every nurse within this many acuity-hours'],
    ['Nurse ratio (patients per nurse)',4,'Base cap on patients per nurse'],
    ['Heavy patient threshold (hrs)',5,'At or above this acuity = a "heavy" patient (spread out, kept from orientees/floats)'],
    ['Points divisor',2,'Checkbox points are divided by this to get acuity hours'],
    ['Total swap first (TRUE/FALSE)',true,'Try handing each outgoing nurse’s whole group to one oncoming nurse before shuffling'],
    ['Total swap tolerance (hrs)',0.5,'Accept the total swap only if hours stay within this spread'],
    ['Handoff weight',6,'How hard to minimize reports when building fresh (keep low — lowest priority)'],
    ['Avoid discharge+admit on one nurse (TRUE/FALSE)',true,'Penalize giving the same nurse a discharge and a fresh admit'],
    ['Shift (Day/Night)','Day','Used for sitter break windows and the History log'],
    ['Max staff on break per slot',2,'Break requests exceeding this per 30-min slot get flagged'],
    ['Big acuity change (hrs)',1.5,'A score that moves this much in one edit gets an attention flag']
  ];
  var setVals=settings.map(function(s){ return [s[0], (old[s[0]]!=null?old[s[0]][0]:s[1]), s[2]]; });
  ru.getRange(3,1,setVals.length,3).setValues(setVals);
  ru.getRange(3,1,setVals.length,1).setFontWeight('bold');
  var fr0=3+settings.length+2;   /* = 16: flag-table header row */
  ru.getRange(fr0,1,1,4).setValues([['Flag','Balance mode (none/spread/cap/ratiocap)','Value','What the flag means']]).setFontWeight('bold');
  var frRows=FLAGS.map(function(f){
    var d=null; DEFAULT_FLAG_RULES.forEach(function(x){ if(x[0]===f[0]) d=x; });
    var mode=d?d[1]:'none', val=d?d[2]:'';
    if(old[f[0]]!=null){ mode=old[f[0]][0]; val=old[f[0]][1]; }
    return [f[0], mode, val, f[1]];
  });
  ru.getRange(fr0+1,1,frRows.length,4).setValues(frRows);
  ru.getRange(fr0+1,2,frRows.length,1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['none','spread','cap','ratiocap'],true).build());
  ru.setColumnWidth(1,240); ru.setColumnWidth(2,240); ru.setColumnWidth(4,260);

  /* Floor */
  var fl=_sheet(FLOOR);
  if(fl.getLastRow()<2){ fl.clear();
    fl.getRange(1,1,1,3).setValues([['Room','Hall (1-4)','Position from station (0 = closest)']]).setFontWeight('bold');
    fl.getRange(2,1,DEFAULT_FLOOR.length,3).setValues(DEFAULT_FLOOR);
  }

  /* Staff — migrate Stage 1 layout (Name|Level|On|Vocera) → Stage 2 (adds Role + break/sitter columns) */
  var st=_sheet(STAFF);
  var header1=String(st.getRange(1,2).getValue()||'');
  if(header1==='Level'){ st.insertColumnAfter(1); st.getRange(1,2).setValue('Role');
    var lastMig=st.getLastRow(); if(lastMig>1) st.getRange(2,2,lastMig-1,1).setValue('RN'); }
  if(st.getLastRow()<2){ st.clear();
    st.getRange(1,1,1,8).setValues([['Name','Role','Level','On today','Vocera','1:1 Room','Break slot','Break OK']]).setFontWeight('bold');
    var sample=[['Anna','RN','RN',true,'',''],['Briana','RN','RN',true,'',''],['Jordan','RN','RN',true,'',''],
      ['Kelsey','RN','RN',true,'',''],['Gracy','RN','RN',true,'',''],['Suja','RN','RN',true,'',''],
      ['Kaitlyn','RN','RN',true,'',''],['Grace','RN','RN',true,'','']];
    st.getRange(2,1,sample.length,6).setValues(sample);
  } else {
    st.getRange(1,1,1,8).setValues([['Name','Role','Level','On today','Vocera','1:1 Room','Break slot','Break OK']]).setFontWeight('bold');
  }
  var lastStaff=Math.max(st.getLastRow(),50);
  st.getRange(2,2,lastStaff-1,1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['RN','PCT','Sitter','HUC'],true).build());
  st.getRange(2,3,lastStaff-1,1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['RN','Senior','Float','Orienting'],true).build());
  st.getRange(2,4,lastStaff-1,1).insertCheckboxes();
  st.getRange(2,7,lastStaff-1,1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(BREAK_SLOTS,true).setAllowInvalid(true).build());
  st.getRange(2,8,lastStaff-1,1).insertCheckboxes();

  /* Scores */
  var sc=_sheet(SCORES);
  var nF=FACTORS.length, firstF=7, lastCol=firstF+nF-1;
  var head=['Room','Suggested','Acuity (hrs)','Next shift','Flags','Nurse'].concat(FACTORS.map(function(f){ return f[0]; }));
  sc.clear();
  sc.getRange(1,1,1,head.length).setValues([head]).setFontWeight('bold').setWrap(true);
  var ptsRow=['','','points →','','',''].concat(FACTORS.map(function(f){ return f[1]; }));
  sc.getRange(2,1,1,ptsRow.length).setValues([ptsRow]).setFontStyle('italic').setFontColor('#888888');
  var floorRooms=fl.getRange(2,1,Math.max(1,fl.getLastRow()-1),1).getValues().map(function(r){ return r[0]; }).filter(function(x){ return x!==''; });
  var f1=_colLetter(firstF), f2=_colLetter(lastCol);
  var divisorCell="'"+RULES+"'!B6";
  var rows=floorRooms.map(function(rn,i){
    var row=3+i;
    var formula='=IF(COUNTIF('+f1+row+':'+f2+row+',TRUE)=0,"",ROUND(SUMPRODUCT(--('+f1+row+':'+f2+row+'=TRUE),$'+f1+'$2:$'+f2+'$2)/'+divisorCell+'*4,0)/4)';
    return {rn:rn, formula:formula};
  });
  if(rows.length){
    sc.getRange(3,1,rows.length,1).setValues(rows.map(function(r){ return [r.rn]; })).setFontWeight('bold');
    rows.forEach(function(r,i){ sc.getRange(3+i,2).setFormula(r.formula); });
    sc.getRange(3,firstF,rows.length,nF).insertCheckboxes();
  }
  sc.getRange(3,2,Math.max(1,rows.length),1).setFontColor('#2E6BE6');
  sc.setFrozenRows(2); sc.setFrozenColumns(1);
  sc.setColumnWidth(5,160);
  _refreshNurseDropdown();

  /* Quick hits */
  var qh=_sheet(QUICK);
  var msg=String(qh.getRange(3,1).getValue()||'');
  qh.clear();
  qh.getRange(1,1).setValue('📣 Quick hits — shift communication (no patient names, room numbers only)').setFontWeight('bold');
  qh.getRange(2,1).setValue('Charge writes/edits the message below. Editing it clears the read-checkmarks so everyone re-acknowledges.').setFontStyle('italic').setFontColor('#888888');
  qh.getRange(3,1).setValue(msg).setWrap(true).setBackground('#FFF8E8');
  qh.setRowHeight(3,80); qh.setColumnWidth(1,420);
  qh.getRange(5,1,1,3).setValues([['Name','Read ✓','When']]).setFontWeight('bold');
  var staffNames=st.getRange(2,1,Math.max(1,st.getLastRow()-1),1).getValues()
    .map(function(r){ return String(r[0]).trim(); }).filter(function(x){ return x!==''; });
  if(staffNames.length){
    qh.getRange(6,1,staffNames.length,1).setValues(staffNames.map(function(n){ return [n]; }));
    qh.getRange(6,2,staffNames.length,1).insertCheckboxes();
  }

  /* History */
  var hi=_sheet(HIST);
  if(hi.getLastRow()<1 || hi.getRange(1,1).getValue()===''){
    hi.getRange(1,1,1,9).setValues([['Date','Shift','Census','Nurses on','Hours spread','Total acuity','Behavioral','Heavy','Total swap?']]).setFontWeight('bold');
    hi.setFrozenRows(1);
  }

  /* Board + Previous */
  var bd=_sheet(BOARD);
  if(bd.getLastRow()<1 || bd.getRange(1,1).getValue()===''){ bd.clear();
    bd.getRange(1,1).setValue('Run EvenShift → ✨ Make Assignment to fill this board.').setFontStyle('italic'); }
  var pv=_sheet(PREV);
  if(pv.getLastRow()<1 || pv.getRange(1,1).getValue()===''){
    pv.getRange(1,1).setValue('Written automatically by End Shift & Hand Off. Do not type here.').setFontStyle('italic'); }

  [BOARD,PREV,RULES,FLOOR,HIST].forEach(function(nm){
    try{ var sh=ss.getSheetByName(nm);
      var ps=sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      if(!ps.length){ sh.protect().setWarningOnly(true); } }catch(e){}
  });

  SpreadsheetApp.getUi().alert('EvenShift is set up.\n\n• Staff: tick what each patient needs on the Scores tab — acuity calculates itself. Request a break on the Staff tab (Break slot column).\n• Charge: check Staff, run ✨ Make Assignment, review the Board, then 📌 Post it.\n• All rules live on the Rules tab. Quick hits carries the shift message with read-receipts.');
}

function _refreshNurseDropdown(){
  var st=_sheet(STAFF), sc=_sheet(SCORES);
  var last=st.getLastRow(); if(last<2) return;
  var data=st.getRange(2,1,last-1,2).getValues();
  var rnNames=data.filter(function(r){ return String(r[1]||'RN')==='RN'||String(r[1])===''; })
    .map(function(r){ return String(r[0]).trim(); }).filter(function(x){ return x!==''; });
  if(!rnNames.length) return;
  var rule=SpreadsheetApp.newDataValidation().requireValueInList(rnNames,true).setAllowInvalid(true).build();
  var lastScore=Math.max(sc.getLastRow(),3);
  sc.getRange(3,6,lastScore-2,1).setDataValidation(rule);
}

function readConfig(){
  var ru=_sheet(RULES);
  var v=function(row){ return ru.getRange(row,2).getValue(); };
  var boolV=function(row,dflt){ var x=v(row); if(x===true) return true; if(x===false) return false;
    var s=String(x).toUpperCase(); return s==='TRUE'?true:(s==='FALSE'?false:dflt); };
  var cfg={ targetSpread:+v(3)||0.5, ratio:+v(4)||4, heavyAt:+v(5)||5, divisor:+v(6)||2,
    swapFirst:boolV(7,true), swapTol:+v(8)||0.5, handoffW:+v(9)||6, avoidDcAdm:boolV(10,true),
    shift:String(v(11)||'Day'), breakCap:+v(12)||2, swingAlert:+v(13)||1.5,
    flagRules:{}, burdenW:BURDEN_W };
  var fr0=16;   /* settings rows 3-13 + 2 gap + header row 16 → rules from 17 */
  var data=ru.getRange(fr0+1,1,FLAGS.length,3).getValues();
  data.forEach(function(row){ var code=String(row[0]||'').trim(); if(!code) return;
    var mode=String(row[1]||'none').trim().toLowerCase();
    if(mode!=='none') cfg.flagRules[code]={mode:mode, value:+row[2]||null}; });
  return cfg;
}

function _parseFlags(text){
  var out=[]; if(!text) return out;
  String(text).split(/[,+\/]/).forEach(function(tok){
    tok=tok.trim().toLowerCase(); if(!tok) return;
    for(var i=0;i<FLAGS.length;i++){ if(FLAGS[i][0]===tok || FLAGS[i][1].toLowerCase()===tok){ out.push(FLAGS[i][0]); return; } }
  });
  return out;
}

function readRooms(useNext){
  var sc=_sheet(SCORES), fl=_sheet(FLOOR);
  var geo={}; fl.getRange(2,1,Math.max(1,fl.getLastRow()-1),3).getValues().forEach(function(r){
    if(r[0]!=='') geo[r[0]]={hall:+r[1]||1,pos:+r[2]||0}; });
  var nF=FACTORS.length, last=sc.getLastRow(); if(last<3) return [];
  var data=sc.getRange(3,1,last-2,6+nF).getValues();
  var rooms=[];
  data.forEach(function(row){
    var id=row[0]; if(id==='') return;
    var suggested=+row[1]||0, typed=+row[2]||0, next=+row[3]||0;
    var acuity=typed>0?typed:suggested;
    var flags=_parseFlags(row[4]);
    for(var f=0;f<nF;f++){ if(row[6+f]===true && FACTORS[f][2] && flags.indexOf(FACTORS[f][2])<0) flags.push(FACTORS[f][2]); }
    var g=geo[id]||{hall:1,pos:0};
    rooms.push({id:id, hall:g.hall, pos:g.pos, acuity:(useNext&&next>0)?next:acuity, nowAcuity:acuity, next:next, flags:flags, nurse:String(row[5]||'').trim()});
  });
  return rooms;
}

function _staffRows(){
  var st=_sheet(STAFF); var last=st.getLastRow(); if(last<2) return [];
  return st.getRange(2,1,last-1,8).getValues().map(function(r,i){
    return { row:i+2, name:String(r[0]).trim(), role:String(r[1]||'RN').trim()||'RN',
      level:String(r[2]||'RN').trim()||'RN', on:r[3]===true, voc:String(r[4]||'').trim(),
      sitRoom:String(r[5]||'').trim(), slot:String(r[6]||'').trim(), slotOK:r[7]===true };
  }).filter(function(x){ return x.name!==''; });
}
function readStaff(){ return _staffRows().filter(function(x){ return x.role==='RN'&&x.on; })
  .map(function(x){ return {name:x.name, level:x.level, voc:x.voc}; }); }
function readPcts(){ return _staffRows().filter(function(x){ return x.role==='PCT'&&x.on; }); }
function readSitters(){ return _staffRows().filter(function(x){ return x.role==='Sitter'&&x.on; })
  .map(function(x){ return {name:x.name, room:x.sitRoom, voc:x.voc}; }); }

function readPrevious(){
  var pv=_sheet(PREV); var last=pv.getLastRow(); if(last<2) return null;
  var data=pv.getRange(2,1,last-1,2).getValues(); var out=[];
  data.forEach(function(r){ var nm=String(r[0]||'').trim(); if(!nm) return;
    var rooms=String(r[1]||'').split(',').map(function(x){ return +x.trim(); }).filter(function(x){ return x>0; });
    if(rooms.length) out.push({name:nm, rooms:rooms}); });
  return out.length?out:null;
}

function makeAssignment(){
  var ui=SpreadsheetApp.getUi();
  var cfg=readConfig();
  var rooms=readRooms(true);
  var occ=rooms.filter(function(r){ return r.acuity>0; });
  var staff=readStaff();
  if(!staff.length){ ui.alert('No RNs are marked "On today" on the Staff tab.'); return; }
  if(!occ.length){ ui.alert('No scored patients on the Scores tab yet — tick some checkboxes or type acuity numbers first.'); return; }
  var prev=readPrevious();
  var res=esGenerate(rooms, staff, prev, cfg);

  /* write Nurse column */
  var sc=_sheet(SCORES); var last=sc.getLastRow();
  var idCol=sc.getRange(3,1,last-2,1).getValues();
  sc.getRange(3,6,idCol.length,1).setValues(idCol.map(function(r){ return [res.assign[r[0]]||'']; })).setBackground(null).clearNote();

  /* supporting cast */
  var pcts=readPcts(), sitters=readSitters();
  var sitRoomSet={}; sitters.forEach(function(s){ if(s.room) sitRoomSet[String(s.room)]=1; });
  var walk=esWalkPos(rooms);
  var zoneRooms=occ.filter(function(r){ return !sitRoomSet[String(r.id)]; })
    .map(function(r){ return r.id; }).sort(function(a,b){ return (walk[a]||0)-(walk[b]||0); });
  var zones=esContigChunks(zoneRooms, pcts.length);
  var medPos={}; staff.forEach(function(n){
    var ps=occ.filter(function(r){ return res.assign[r.id]===n.name; }).map(function(r){ return walk[r.id]||0; }).sort(function(a,b){ return a-b; });
    medPos[n.name]=ps.length?ps[Math.floor(ps.length/2)]:0; });
  var withRooms=staff.map(function(n){ return n.name; }).filter(function(nm){ return occ.some(function(r){ return res.assign[r.id]===nm; }); });
  var buddies=esBuddyPairs(withRooms, medPos);
  var pctBuddies=esBuddyPairs(pcts.map(function(p){ return p.name; }), (function(){ var m={}; pcts.forEach(function(p,i){ m[p.name]=i; }); return m; })());
  var codeTeam=esCodeTeam(staff, pcts.map(function(p){ return p.name; }));
  var sitCov=esSitterCoverage(sitters.filter(function(s){ return s.room; }), pcts.map(function(p){ return p.name; }), cfg.shift);
  var needSit=occ.filter(function(r){ return r.flags.indexOf('sit')>=0 && !sitters.some(function(s){ return String(s.room)===String(r.id); }); });

  /* break requests summary */
  var reqs=_staffRows().filter(function(x){ return x.on && x.slot; });
  var slotCount={}; reqs.forEach(function(x){ slotCount[x.slot]=(slotCount[x.slot]||0)+1; });

  /* Board */
  var bd=_sheet(BOARD); bd.clear();
  var L=[];
  var pad=function(a){ while(a.length<4) a.push(''); return a; };
  L.push(pad(['EvenShift — Assignment']));
  L.push(pad(['Generated '+new Date().toLocaleString()+' · '+occ.length+' patients · '+staff.length+' RN · '+pcts.length+' PCT · '+sitters.length+' sitter']));
  L.push(pad(['✏️ DRAFT — post when final (EvenShift → 📌 Post / unpost)']));
  var verdict = res.spread<=cfg.targetSpread ? '✓ Even — nurses within '+res.spread.toFixed(1)+' hrs'
    : res.spread<=1.5 ? '✓ Balanced — within '+res.spread.toFixed(1)+' hrs'
    : '⚠ Hours ±'+res.spread.toFixed(1)+' hrs — consider adding staff';
  L.push(pad([verdict]));
  if(res.swap){
    L.push(pad([res.swap.ok
      ? '✓ TOTAL SWAP — each oncoming nurse took one outgoing nurse’s whole group (hours within ±'+res.swap.spread.toFixed(1)+')'
      : 'Total swap checked first — not possible ('+(res.swap.reason==='hours'?('hours would be ±'+res.swap.spread.toFixed(1)):'staffing changed')+'); built a fresh balanced board.']));
  }
  L.push(pad(['']));
  L.push(['Nurse','Rooms','Patients','Hours']);
  var byNurse={};
  occ.forEach(function(r){ var nm=res.assign[r.id]; if(!nm) return; (byNurse[nm]=byNurse[nm]||[]).push(r); });
  staff.forEach(function(n){
    var g=(byNurse[n.name]||[]).sort(function(a,b){ return a.id-b.id; });
    L.push([n.name+(n.level!=='RN'?' ('+n.level.toLowerCase()+')':'')+(n.voc?' · 📟 '+n.voc:''),
      g.map(function(r){ return r.id; }).join(', ')||'—', g.length, Math.round(g.reduce(function(s,r){ return s+r.acuity; },0)*10)/10]);
  });
  var un=occ.filter(function(r){ return !res.assign[r.id]; });
  if(un.length) L.push(['Unassigned', un.map(function(r){ return r.id; }).join(', '), un.length, '']);
  if(res.handoff.length){
    L.push(pad([''])); L.push(pad(['Shift-change reports (who gives report to whom)']));
    res.handoff.forEach(function(h){
      var others=h.to.filter(function(t){ return t.name!==h.from; });
      var keeps=h.to.filter(function(t){ return t.name===h.from; });
      var parts=[];
      if(keeps.length) parts.push('keeps '+keeps[0].n);
      if(others.length) parts.push(others.length+' report'+(others.length>1?'s':'')+': '+others.map(function(t){ return t.name+' ('+t.n+')'; }).join(' + '));
      L.push(pad([h.from+' → '+(parts.join(' · ')||'—')]));
    });
  }
  if(pcts.length){
    L.push(pad([''])); L.push(['PCT zones','Rooms','','']);
    pcts.forEach(function(p,i){ L.push([p.name+(p.voc?' · 📟 '+p.voc:''), (zones[i]||[]).join(', ')||'—','','']); });
  }
  if(sitters.length||needSit.length){
    L.push(pad([''])); L.push(['1:1 Sitters','Room','Break','Covered by']);
    sitCov.forEach(function(c){ L.push([c.sitter, 'Rm '+c.room, c.window, c.cover]); });
    sitters.filter(function(s){ return !s.room; }).forEach(function(s){ L.push([s.name,'— set 1:1 Room on Staff tab','','']); });
    if(needSit.length) L.push(pad(['⚠ 1:1-flagged room'+(needSit.length>1?'s':'')+' with no sitter: '+needSit.map(function(r){ return r.id; }).join(', ')]));
  }
  if(buddies.length){
    L.push(pad([''])); L.push(pad(['Break buddies (cover each other)']));
    buddies.forEach(function(g){ if(g.length>1) L.push(pad(['RN: '+g.join('  ⇄  ')])); });
    pctBuddies.forEach(function(g){ if(g.length>1) L.push(pad(['PCT: '+g.join('  ⇄  ')])); });
  }
  if(reqs.length){
    L.push(pad([''])); L.push(['Break requests','Slot','Approved?','']);
    reqs.forEach(function(x){
      var over=slotCount[x.slot]>cfg.breakCap?' ⚠ slot over cap ('+slotCount[x.slot]+'/'+cfg.breakCap+')':'';
      L.push([x.name+' ('+x.role+')', x.slot, (x.slotOK?'✓ approved':'⏳ waiting')+over,'']);
    });
    L.push(pad(['Charge: approve by ticking "Break OK" on the Staff tab.']));
  }
  if(staff.length){
    L.push(pad([''])); L.push(pad(['Code blue team']));
    codeTeam.forEach(function(r){ L.push([r.role, r.who||'unfilled', r.hint,'']); });
  }
  if(res.violations.length){
    L.push(pad([''])); L.push(pad(['⚠ Could not fully balance (the floor forced it):']));
    res.violations.forEach(function(v){ L.push(pad([v])); });
  }
  bd.getRange(1,1,L.length,4).setValues(L);
  bd.getRange(1,1).setFontWeight('bold').setFontSize(14);
  bd.getRange(3,1,1,4).setBackground('#FDF1DC').setFontWeight('bold');
  bd.getRange(7,1,1,4).setFontWeight('bold');
  bd.setColumnWidth(1,300); bd.setColumnWidth(2,300); bd.setColumnWidth(3,160); bd.setColumnWidth(4,160);

  _props().setProperties({ posted:'0', lastSpread:String(res.spread),
    lastSwap:(res.swap&&res.swap.ok)?'1':'0',
    buddies:JSON.stringify(buddies.concat(pctBuddies)) });
  ss_toast(res.swap&&res.swap.ok ? 'Total swap — 1 report per outgoing nurse. Spread '+res.spread.toFixed(1)+' hrs.' : 'Assignment made. Spread '+res.spread.toFixed(1)+' hrs. Review the Board, then 📌 Post it.');
}

function togglePosted(){
  var bd=_sheet(BOARD);
  if(String(bd.getRange(1,1).getValue()).indexOf('EvenShift')!==0){ SpreadsheetApp.getUi().alert('Make an assignment first.'); return; }
  var p=_props(); var posted=p.getProperty('posted')==='1';
  posted=!posted; p.setProperty('posted', posted?'1':'0');
  if(posted) bd.getRange(3,1,1,4).setValues([['✅ POSTED — this assignment is final. Staff can trust it.','','','']]).setBackground('#E3F4EA');
  else bd.getRange(3,1,1,4).setValues([['✏️ DRAFT — post when final (EvenShift → 📌 Post / unpost)','','','']]).setBackground('#FDF1DC');
  ss_toast(posted?'Posted — the board is marked final.':'Back to draft.');
}

function ss_toast(msg){ try{ _ss().toast(msg,'EvenShift',6); }catch(e){} }

function endShift(){
  var ui=SpreadsheetApp.getUi();
  var resp=ui.alert('End Shift & Hand Off','Saves who had which rooms to Previous, logs this shift to History, copies "Next shift" scores into Acuity, clears the Nurse column and break requests.\n\nContinue?',ui.ButtonSet.OK_CANCEL);
  if(resp!==ui.Button.OK) return;
  var cfg=readConfig();
  var sc=_sheet(SCORES); var last=sc.getLastRow(); if(last<3) return;
  var data=sc.getRange(3,1,last-2,6).getValues();
  var rooms=readRooms(false);
  var occ=rooms.filter(function(r){ return r.acuity>0; });
  var byNurse={};
  data.forEach(function(r){ var nm=String(r[5]||'').trim(); if(!nm) return;
    var ac=+r[2]||+r[1]||0; if(!(ac>0)) return;
    (byNurse[nm]=byNurse[nm]||[]).push(r[0]); });

  /* History row */
  try{
    var hist=_sheet(HIST); var p=_props();
    hist.appendRow([ new Date().toLocaleDateString(), cfg.shift, occ.length, readStaff().length,
      +(p.getProperty('lastSpread')||0), Math.round(occ.reduce(function(s,r){ return s+r.acuity; },0)*10)/10,
      occ.filter(function(r){ return r.flags.indexOf('beh')>=0; }).length,
      occ.filter(function(r){ return r.acuity>=cfg.heavyAt; }).length,
      p.getProperty('lastSwap')==='1'?'yes':'no' ]);
  }catch(e){}

  /* Previous */
  var pv=_sheet(PREV); pv.clear();
  pv.getRange(1,1,1,2).setValues([['Nurse (last shift)','Rooms']]).setFontWeight('bold');
  var rows=Object.keys(byNurse).map(function(nm){ return [nm, byNurse[nm].join(', ')]; });
  if(rows.length) pv.getRange(2,1,rows.length,2).setValues(rows);

  /* Next shift → Acuity, clear Next + Nurse */
  var updates=data.map(function(r){ var next=+r[3]||0; return [ next>0?next:r[2] ]; });
  sc.getRange(3,3,updates.length,1).setValues(updates);
  sc.getRange(3,4,updates.length,1).clearContent();
  sc.getRange(3,6,updates.length,1).clearContent().setBackground(null).clearNote();

  /* clear break requests for the new shift */
  var st=_sheet(STAFF); var lastS=st.getLastRow();
  if(lastS>=2){ st.getRange(2,7,lastS-1,1).clearContent().setBackground(null).clearNote(); st.getRange(2,8,lastS-1,1).setValue(false); }
  _props().setProperty('posted','0');
  ss_toast('Shift saved to Previous + History. Next charge: check Staff, then Make Assignment.');
}

function clearBoard(){
  var ui=SpreadsheetApp.getUi();
  var resp=ui.alert('Clear the board?','Clears the Nurse column and the Board tab. Scores stay.',ui.ButtonSet.OK_CANCEL);
  if(resp!==ui.Button.OK) return;
  var sc=_sheet(SCORES); var last=sc.getLastRow();
  if(last>=3) sc.getRange(3,6,last-2,1).clearContent().setBackground(null).clearNote();
  var bd=_sheet(BOARD); bd.clear();
  bd.getRange(1,1).setValue('Run EvenShift → ✨ Make Assignment to fill this board.').setFontStyle('italic');
  _props().setProperty('posted','0');
}

/* ── Live reactions: Scores nurse edits & acuity swings · Staff break requests · Quick hits ── */
function onEdit(e){
  try{
    if(!e || !e.range) return;
    var sh=e.range.getSheet(), name=sh.getName(), col=e.range.getColumn(), row=e.range.getRow();

    if(name===SCORES && col===6 && row>=3){ _warnNurseEdit(e, sh); return; }
    if(name===SCORES && col===3 && row>=3){ _warnSwing(e); return; }
    if(name===STAFF && (col===7||col===8) && row>=2){ _warnBreak(e, sh, row); return; }
    if(name===QUICK){
      if(row===3 && col===1){ /* message changed → everyone re-acknowledges */
        var lastQ=sh.getLastRow();
        if(lastQ>=6){ sh.getRange(6,2,lastQ-5,1).setValue(false); sh.getRange(6,3,lastQ-5,1).clearContent(); }
        return;
      }
      if(col===2 && row>=6){ sh.getRange(row,3).setValue(e.value==='TRUE'||e.value===true ? new Date().toLocaleString() : ''); return; }
    }
  }catch(err){ /* never block the edit */ }
}

function _warnNurseEdit(e, sh){
  var cfg=readConfig();
  var rooms=readRooms(false);
  var nurseName=String(e.value||'').trim();
  e.range.setBackground(null).clearNote();
  if(!nurseName) return;
  var rec=null;
  _staffRows().forEach(function(x){ if(x.name.toLowerCase()===nurseName.toLowerCase()) rec=x; });
  var probs=[];
  if(!rec) probs.push('"'+nurseName+'" is not on the Staff tab');
  else if(rec.role!=='RN') probs.push(nurseName+' is listed as '+rec.role+', not an RN');
  var level=rec?rec.level:'RN';
  var mine=rooms.filter(function(r){ return r.nurse.toLowerCase()===nurseName.toLowerCase() && r.acuity>0; });
  var thisRoom=rooms.filter(function(r){ return String(r.id)===String(sh.getRange(e.range.getRow(),1).getValue()); })[0];
  if(thisRoom){
    if(level==='Orienting' && (thisRoom.acuity>=cfg.heavyAt||thisRoom.flags.indexOf('beh')>=0)) probs.push('orienting nurse should not take a '+(thisRoom.acuity>=cfg.heavyAt?'heavy ('+cfg.heavyAt+'+)':'behavioral')+' patient');
    if(level==='Float' && (thisRoom.acuity>=cfg.heavyAt||thisRoom.flags.indexOf('beh')>=0||thisRoom.flags.indexOf('sit')>=0)) probs.push('float nurse should not take this patient');
  }
  var beh=mine.filter(function(r){ return r.flags.indexOf('beh')>=0; }).length;
  var heavy=mine.filter(function(r){ return r.acuity>=cfg.heavyAt; }).length;
  var behCap=(cfg.flagRules.beh&&cfg.flagRules.beh.mode==='cap')?Math.max(1,cfg.flagRules.beh.value||1):1;
  if(beh>behCap) probs.push(nurseName+' now has '+beh+' behavioral patients (cap '+behCap+')');
  if(heavy>1) probs.push(nurseName+' now has '+heavy+' heavy ('+cfg.heavyAt+'+) patients');
  var cap=cfg.ratio;
  mine.forEach(function(r){ for(var code in cfg.flagRules){ if(cfg.flagRules[code].mode==='ratiocap' && r.flags.indexOf(code)>=0) cap=Math.min(cap,Math.max(1,cfg.flagRules[code].value||cfg.ratio)); } });
  if(mine.length>cap) probs.push(nurseName+' has '+mine.length+' patients but their flags limit them to '+cap);
  if(probs.length){ e.range.setBackground('#F3D3DD').setNote('⚠ '+probs.join('\n⚠ ')); }
}

function _warnSwing(e){
  var cfg=readConfig();
  var oldV=+e.oldValue||0, newV=+e.value||0;
  e.range.setBackground(null);
  if(oldV>0 && newV>0 && Math.abs(newV-oldV)>=cfg.swingAlert){
    e.range.setBackground('#FFF3D6').setNote('⚠ Big change: was '+oldV+', now '+newV+'.\nDouble-check it, and tell the charge why (procedure, off a drip, decompensating…).');
  } else e.range.clearNote();
}

function _warnBreak(e, sh, row){
  var cfg=readConfig();
  var all=_staffRows();
  var me=null; all.forEach(function(x){ if(x.row===row) me=x; });
  var slotCell=sh.getRange(row,7);
  slotCell.setBackground(null).clearNote();
  if(!me || !me.slot) return;
  var probs=[];
  var sameSlot=all.filter(function(x){ return x.on && x.slot===me.slot; });
  if(sameSlot.length>cfg.breakCap) probs.push('slot '+me.slot+' now has '+sameSlot.length+' people (max '+cfg.breakCap+')');
  try{
    var buddies=JSON.parse(_props().getProperty('buddies')||'[]');
    buddies.forEach(function(g){
      if(g.indexOf(me.name)<0) return;
      g.forEach(function(other){ if(other!==me.name && sameSlot.some(function(x){ return x.name===other; }))
        probs.push('break buddy '+other+' is on the same slot — no one covers'); });
    });
  }catch(err){}
  if(me.role==='Sitter' && me.sitRoom) probs.push('1:1 sitter — make sure Rm '+me.sitRoom+' is watched during this break (see Board → Covered by)');
  if(probs.length){ slotCell.setBackground(probs.some(function(p){ return p.indexOf('max')>=0||p.indexOf('buddy')>=0; })?'#F3D3DD':'#FFF3D6').setNote('⚠ '+probs.join('\n⚠ ')); }
}
