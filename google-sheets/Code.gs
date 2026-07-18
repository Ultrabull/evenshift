/** ═══════════════════════════════════════════════════════════════════════════
 *  EVENSHIFT FOR GOOGLE SHEETS — Stage 1 (workhorse edition)
 *
 *  Paste this whole file into Extensions → Apps Script (replace the empty
 *  myFunction), hit Save, then reload the spreadsheet. An "EvenShift" menu
 *  appears — run "Set up sheets" once. Full guide: SETUP.md in the repo.
 *
 *  What it does:
 *   · Scores tab — staff tick intervention checkboxes; acuity calculates itself
 *   · Make Assignment — the real EvenShift engine, ported from the web app:
 *       priority: acuity hours ▸ safety caps ▸ hallway grouping ▸ burden mix
 *       ▸ handoff continuity (total swap FIRST when acuity stays even)
 *   · Live warnings — hand-edit a Nurse cell and rule violations flag instantly
 *   · End Shift & Hand Off — snapshots who-had-what so the next assignment can
 *       keep whole groups together (1 report per outgoing nurse)
 *
 *  Everything runs inside your Google Workspace. No external services.
 *  Room numbers only — no patient names.
 *  ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── Tab & column layout ─────────────────────────────
 * Scores : A Room | B Suggested | C Acuity | D Next Shift | E Flags | F Nurse
 *          | G.. one checkbox column per quick factor (row 2 holds the points)
 * Staff  : A Name | B Level | C On today | D Vocera
 * Floor  : A Room | B Hall (1-4) | C Position from station (0 = closest)
 * Rules  : settings block + flag-rules table (all editable)
 * Board  : generated output (do not type here)
 * Previous : written by End Shift (do not type here)
 * ─────────────────────────────────────────────────────────────────────────── */

var SCORES = 'Scores', STAFF = 'Staff', FLOOR = 'Floor', RULES = 'Rules', BOARD = 'Board', PREV = 'Previous';

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

/* Default balancing rule per flag (all editable on the Rules tab).
 * Modes: none | spread (share out evenly) | cap (max N per nurse) | ratiocap (nurse with it takes max N patients total) */
var DEFAULT_FLAG_RULES = [
  ['beh','cap',1],['ins','ratiocap',3],['cvl','spread',''],['trach','cap',1],['tot','spread',''],
  ['sit','spread',''],['conf','spread',''],['dc','spread',''],['adm','spread','']
];

/* Burden weights — how much each flag "costs" when piled on one nurse (same defaults as the app). */
var BURDEN_W = { beh:4, conf:4, trach:4, airb:4, tot:3, sit:3, chest:3, restr:3, dc:3, hd:2.5,
  adm:2, cvl:1.5, picc:1.5, gtt:2, hep:2, ins:2, wound:2, iso:1.5, foley:1, dht:1, hi:0 };

/* 10 Green default floor — replace on the Floor tab for your unit. [room, hall, position] */
var DEFAULT_FLOOR = (function(){
  var halls = { 1:[49,47,45,43,41,39,37,35,33], 2:[46,44,42,40,38,36,34], 3:[51,53,55,57,59,61,63,65], 4:[50,52,54,56,58,60,62,64] };
  var out = [];
  [1,2,3,4].forEach(function(h){ halls[h].forEach(function(rn,i){ out.push([rn,h,i]); }); });
  return out;
})();

/* ═════════════════════════ ENGINE START ════════════════════════════════════
 * Pure JavaScript — no Sheets calls. Ported from the EvenShift web app so the
 * Sheet and the app follow the SAME rules. Tested headless in Node.
 *
 * room  : {id, hall, pos, acuity, flags:[]}        (acuity = the hours number)
 * nurse : {name, level}   level: RN|Senior|Float|Orienting
 * prev  : [{name, rooms:[ids]}] or null            (last shift's groups)
 * cfg   : {targetSpread, ratio, heavyAt, divisor, swapFirst, swapTol,
 *          handoffW, avoidDcAdm, flagRules:{code:{mode,value}}, burdenW:{}}
 * returns {assign:{roomId:nurseName}, spread, swap:{ok,reason,spread}|null,
 *          handoff:[{from,to:[{name,n}]}], violations:[strings]}
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
    for(var pass=0; pass<3; pass++){
      if(pass>0){ var pool=[]; G.forEach(function(g){ while(g.length){ pool.push(g.pop()); } });
        for(var k1=pool.length-1;k1>0;k1--){ var q=Math.floor(Math.random()*(k1+1)); var tmp=pool[k1]; pool[k1]=pool[q]; pool[q]=tmp; }
        pool.forEach(function(r){ var sm=0; for(var x=1;x<M;x++) if(G[x].length<G[sm].length) sm=x; G[sm].push(r); }); }
      var cur=cost(), passBestC=cur, passBest=G.map(function(g){ return g.slice(); }), T=8;
      for(var it=0; it<15000; it++){
        T*=0.99965;
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
    /* match groups → nurses: safety constraints, prefer last shift's owner */
    var canTake=function(n,gi){ for(var k=0;k<G[gi].length;k++){ if(!esEligible(n,G[gi][k],cfg)) return false; } return true; };
    var gPrev=G.map(function(g){ var tally={},bn=0,bestN=null;
      g.forEach(function(r){ var pv=prevOwner[r.id]; if(pv==null) return; tally[pv]=(tally[pv]||0)+1; if(tally[pv]>bn){bn=tally[pv];bestN=pv;} });
      return bestN; });
    var mIds=new Array(M).fill(null), mUsed={};
    var mbt=function(oi){ if(oi>=M) return true; var n=nurses[oi];
      var cands=[]; for(var gi=0;gi<M;gi++) if(mIds[gi]==null && canTake(n,gi)) cands.push(gi);
      cands.sort(function(x,y){ return (gPrev[y]===n.name?1:0)-(gPrev[x]===n.name?1:0); });
      for(var c=0;c<cands.length;c++){ var gi3=cands[c]; mIds[gi3]=n.name;
        if(mbt(oi+1)) return true; mIds[gi3]=null; }
      return false; };
    var sorted=nurses.map(function(n,i){ return i; }).sort(function(a,b){
      var ra2=(nurses[a].level==='Orienting'||nurses[a].level==='Float')?0:1;
      var rb2=(nurses[b].level==='Orienting'||nurses[b].level==='Float')?0:1; return ra2-rb2; });
    var ordNurses=sorted.map(function(i){ return nurses[i]; });
    var saveN=nurses; nurses=ordNurses;
    if(!mbt(0)){ mIds=G.map(function(g,gi){ return saveN[gi%M].name; }); }
    nurses=saveN;
    ids=mIds;
  }

  G.forEach(function(g,gi){ g.forEach(function(r){ out.assign[r.id]=ids[gi]; }); });
  out.spread=Math.round(spread()*100)/100;

  /* handoff mapping for the Board */
  if(hasHandoff){
    var map={};
    (prev||[]).forEach(function(rec){ var tally={};
      (rec.rooms||[]).forEach(function(rn){ var nm=out.assign[rn]; if(!nm) return; tally[nm]=(tally[nm]||0)+1; });
      var to=Object.keys(tally).map(function(nm){ return {name:nm,n:tally[nm]}; }).sort(function(a,b){ return b.n-a.n; });
      if(to.length) out.handoff.push({from:rec.name, to:to}); });
  }

  /* violations report (post-check, mirrors the app's checkFlagViolations) */
  G.forEach(function(g,gi){
    var b=g.filter(function(r){ return r.flags.indexOf('beh')>=0; }).length;
    var h=g.filter(function(r){ return r.acuity>=cfg.heavyAt; }).length;
    if(b>capBeh) out.violations.push(ids[gi]+' has '+b+' behavioral patients (aim '+capBeh+')');
    if(h>capHeavy) out.violations.push(ids[gi]+' has '+h+' heavy ('+cfg.heavyAt+'+) patients (aim '+capHeavy+')');
    var cap=groupRatioCap(g); if(g.length>cap) out.violations.push(ids[gi]+' has '+g.length+' patients but a flag limits them to '+cap);
  });
  return out;
}
/* ═════════════════════════ ENGINE END ══════════════════════════════════════ */

/* ─────────────────────────── Sheets wiring ──────────────────────────────── */

function onOpen(){
  SpreadsheetApp.getUi().createMenu('EvenShift')
    .addItem('✨ Make Assignment','makeAssignment')
    .addItem('🔄 End Shift & Hand Off','endShift')
    .addItem('🧹 Clear Board','clearBoard')
    .addSeparator()
    .addItem('⚙️ Set up sheets (first run / repair)','setupSheets')
    .addToUi();
}

function _ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function _sheet(name){ var s=_ss().getSheetByName(name); if(!s) s=_ss().insertSheet(name); return s; }
function _colLetter(n){ var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); } return s; }

function setupSheets(){
  var ss=_ss();

  /* Rules */
  var ru=_sheet(RULES); ru.clear();
  ru.getRange(1,1,1,2).setValues([['EvenShift rules — every value here is editable','']]).setFontWeight('bold');
  var settings=[
    ['Target evenness (hrs)',0.5,'Assignment aims for every nurse within this many acuity-hours'],
    ['Nurse ratio (patients per nurse)',4,'Base cap on patients per nurse'],
    ['Heavy patient threshold (hrs)',5,'At or above this acuity = a "heavy" patient (spread out, kept from orientees/floats)'],
    ['Points divisor',2,'Checkbox points are divided by this to get acuity hours'],
    ['Total swap first (TRUE/FALSE)',true,'Try handing each outgoing nurse’s whole group to one oncoming nurse before shuffling'],
    ['Total swap tolerance (hrs)',0.5,'Accept the total swap only if hours stay within this spread'],
    ['Handoff weight',6,'How hard to minimize reports when building fresh (keep low — lowest priority)'],
    ['Avoid discharge+admit on one nurse (TRUE/FALSE)',true,'Penalize giving the same nurse a discharge and a fresh admit']
  ];
  ru.getRange(3,1,settings.length,3).setValues(settings);
  ru.getRange(3,1,settings.length,1).setFontWeight('bold');
  var fr0=3+settings.length+2;
  ru.getRange(fr0,1,1,4).setValues([['Flag','Balance mode (none/spread/cap/ratiocap)','Value','What the flag means']]).setFontWeight('bold');
  var frRows=FLAGS.map(function(f){
    var d=null; DEFAULT_FLAG_RULES.forEach(function(x){ if(x[0]===f[0]) d=x; });
    return [f[0], d?d[1]:'none', d?d[2]:'', f[1]];
  });
  ru.getRange(fr0+1,1,frRows.length,4).setValues(frRows);
  var modeRule=SpreadsheetApp.newDataValidation().requireValueInList(['none','spread','cap','ratiocap'],true).build();
  ru.getRange(fr0+1,2,frRows.length,1).setDataValidation(modeRule);
  ru.setColumnWidth(1,220); ru.setColumnWidth(2,240); ru.setColumnWidth(4,260);

  /* Floor */
  var fl=_sheet(FLOOR);
  if(fl.getLastRow()<2){ fl.clear();
    fl.getRange(1,1,1,3).setValues([['Room','Hall (1-4)','Position from station (0 = closest)']]).setFontWeight('bold');
    fl.getRange(2,1,DEFAULT_FLOOR.length,3).setValues(DEFAULT_FLOOR);
  }

  /* Staff */
  var st=_sheet(STAFF);
  if(st.getLastRow()<2){ st.clear();
    st.getRange(1,1,1,4).setValues([['Name','Level','On today','Vocera']]).setFontWeight('bold');
    var sample=[['Anna','RN',true,''],['Briana','RN',true,''],['Jordan','RN',true,''],['Kelsey','RN',true,''],
      ['Gracy','RN',true,''],['Suja','RN',true,''],['Kaitlyn','RN',true,''],['Grace','RN',true,'']];
    st.getRange(2,1,sample.length,4).setValues(sample);
  }
  var lastStaff=Math.max(st.getLastRow(),50);
  st.getRange(2,2,lastStaff-1,1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['RN','Senior','Float','Orienting'],true).build());
  st.getRange(2,3,lastStaff-1,1).insertCheckboxes();

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

  /* Board + Previous */
  var bd=_sheet(BOARD);
  if(bd.getLastRow()<1 || bd.getRange(1,1).getValue()===''){ bd.clear();
    bd.getRange(1,1).setValue('Run EvenShift → ✨ Make Assignment to fill this board.').setFontStyle('italic'); }
  var pv=_sheet(PREV);
  if(pv.getLastRow()<1 || pv.getRange(1,1).getValue()===''){
    pv.getRange(1,1).setValue('Written automatically by End Shift & Hand Off. Do not type here.').setFontStyle('italic'); }

  /* gentle protection: warn before editing generated/config tabs */
  [BOARD,PREV,RULES,FLOOR].forEach(function(nm){
    try{ var sh=ss.getSheetByName(nm);
      var ps=sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      if(!ps.length){ sh.protect().setWarningOnly(true); } }catch(e){}
  });

  SpreadsheetApp.getUi().alert('EvenShift is set up.\n\n• Staff: tick what each patient needs on the Scores tab — acuity calculates itself (or type it in the Acuity column).\n• Charge: check the Staff tab, then run EvenShift → ✨ Make Assignment.\n• All rules live on the Rules tab — edit the cells, the next assignment obeys.');
}

function _refreshNurseDropdown(){
  var st=_sheet(STAFF), sc=_sheet(SCORES);
  var last=st.getLastRow(); if(last<2) return;
  var rule=SpreadsheetApp.newDataValidation().requireValueInRange(st.getRange(2,1,last-1,1),true).setAllowInvalid(true).build();
  var lastScore=Math.max(sc.getLastRow(),3);
  sc.getRange(3,6,lastScore-2,1).setDataValidation(rule);
}

function readConfig(){
  var ru=_sheet(RULES);
  var v=function(row){ return ru.getRange(row,2).getValue(); };
  var cfg={ targetSpread:+v(3)||0.5, ratio:+v(4)||4, heavyAt:+v(5)||5, divisor:+v(6)||2,
    swapFirst:v(7)===true||String(v(7)).toUpperCase()==='TRUE', swapTol:+v(8)||0.5,
    handoffW:+v(9)||6, avoidDcAdm:v(10)===true||String(v(10)).toUpperCase()==='TRUE',
    flagRules:{}, burdenW:BURDEN_W };
  var fr0=13;  /* settings start row 3, 8 rows, +2 gap, header → first rule row 14 */
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

function readStaff(){
  var st=_sheet(STAFF); var last=st.getLastRow(); if(last<2) return [];
  return st.getRange(2,1,last-1,3).getValues()
    .filter(function(r){ return String(r[0]).trim()!=='' && r[2]===true; })
    .map(function(r){ return {name:String(r[0]).trim(), level:String(r[1]||'RN').trim()||'RN'}; });
}

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
  var rooms=readRooms(true);          /* build from Next Shift where entered, else current acuity */
  var occ=rooms.filter(function(r){ return r.acuity>0; });
  var staff=readStaff();
  if(!staff.length){ ui.alert('No one is marked "On today" on the Staff tab.'); return; }
  if(!occ.length){ ui.alert('No scored patients on the Scores tab yet — tick some checkboxes or type acuity numbers first.'); return; }
  var prev=readPrevious();
  var res=esGenerate(rooms, staff, prev, cfg);

  /* write Nurse column */
  var sc=_sheet(SCORES); var last=sc.getLastRow();
  var ids=sc.getRange(3,1,last-2,1).getValues();
  var nurseCol=ids.map(function(r){ return [res.assign[r[0]]||'']; });
  sc.getRange(3,6,nurseCol.length,1).setValues(nurseCol).setBackground(null).clearNote();

  /* write Board */
  var bd=_sheet(BOARD); bd.clear();
  var lines=[];
  lines.push(['EvenShift — Assignment','','','']);
  lines.push(['Generated '+new Date().toLocaleString()+' · '+occ.length+' patients · '+staff.length+' nurses','','','']);
  var verdict = res.spread<=cfg.targetSpread ? '✓ Even — nurses within '+res.spread.toFixed(1)+' hrs'
    : res.spread<=1.5 ? '✓ Balanced — within '+res.spread.toFixed(1)+' hrs'
    : '⚠ Hours ±'+res.spread.toFixed(1)+' hrs — consider adding staff';
  lines.push([verdict,'','','']);
  if(res.swap){
    lines.push([res.swap.ok
      ? '✓ TOTAL SWAP — each oncoming nurse took one outgoing nurse’s whole group (hours within ±'+res.swap.spread.toFixed(1)+')'
      : 'Total swap checked first — not possible ('+(res.swap.reason==='hours'?('hours would be ±'+res.swap.spread.toFixed(1)):'staffing changed')+'); built a fresh balanced board.','','','']);
  }
  lines.push(['','','','']);
  lines.push(['Nurse','Rooms','Patients','Hours']);
  var byNurse={};
  occ.forEach(function(r){ var nm=res.assign[r.id]; if(!nm) return; (byNurse[nm]=byNurse[nm]||[]).push(r); });
  staff.forEach(function(n){
    var g=(byNurse[n.name]||[]).sort(function(a,b){ return a.id-b.id; });
    lines.push([n.name+(n.level!=='RN'?' ('+n.level.toLowerCase()+')':''),
      g.map(function(r){ return r.id; }).join(', ')||'—', g.length, Math.round(g.reduce(function(s,r){ return s+r.acuity; },0)*10)/10]);
  });
  var un=occ.filter(function(r){ return !res.assign[r.id]; });
  if(un.length) lines.push(['Unassigned', un.map(function(r){ return r.id; }).join(', '), un.length, '']);
  if(res.handoff.length){
    lines.push(['','','','']);
    lines.push(['Shift-change reports (who gives report to whom)','','','']);
    res.handoff.forEach(function(h){
      var others=h.to.filter(function(t){ return t.name!==h.from; });
      var keeps=h.to.filter(function(t){ return t.name===h.from; });
      var parts=[];
      if(keeps.length) parts.push('keeps '+keeps[0].n);
      if(others.length) parts.push(others.length+' report'+(others.length>1?'s':'')+': '+others.map(function(t){ return t.name+' ('+t.n+')'; }).join(' + '));
      lines.push([h.from+' → '+(parts.join(' · ')||'—'),'','','']);
    });
  }
  if(res.violations.length){
    lines.push(['','','','']);
    lines.push(['⚠ Could not fully balance (the floor forced it):','','','']);
    res.violations.forEach(function(v){ lines.push([v,'','','']); });
  }
  bd.getRange(1,1,lines.length,4).setValues(lines);
  bd.getRange(1,1).setFontWeight('bold').setFontSize(14);
  bd.getRange(6,1,1,4).setFontWeight('bold');
  bd.setColumnWidth(1,320); bd.setColumnWidth(2,320);
  bd.autoResizeColumns(3,2);
  ss_toast(res.swap&&res.swap.ok ? 'Total swap — 1 report per outgoing nurse. Spread '+res.spread.toFixed(1)+' hrs.' : 'Assignment made. Spread '+res.spread.toFixed(1)+' hrs.');
}

function ss_toast(msg){ try{ _ss().toast(msg,'EvenShift',6); }catch(e){} }

function endShift(){
  var ui=SpreadsheetApp.getUi();
  var resp=ui.alert('End Shift & Hand Off','Saves who had which rooms to the Previous tab (so the next assignment can keep whole groups together), copies "Next shift" scores into Acuity, and clears the Nurse column.\n\nContinue?',ui.ButtonSet.OK_CANCEL);
  if(resp!==ui.Button.OK) return;
  var sc=_sheet(SCORES); var last=sc.getLastRow(); if(last<3) return;
  var data=sc.getRange(3,1,last-2,6).getValues();
  var byNurse={};
  data.forEach(function(r){ var nm=String(r[5]||'').trim(); if(!nm) return;
    var ac=+r[2]||+r[1]||0; if(!(ac>0)) return;
    (byNurse[nm]=byNurse[nm]||[]).push(r[0]); });
  var pv=_sheet(PREV); pv.clear();
  pv.getRange(1,1,1,2).setValues([['Nurse (last shift)','Rooms']]).setFontWeight('bold');
  var rows=Object.keys(byNurse).map(function(nm){ return [nm, byNurse[nm].join(', ')]; });
  if(rows.length) pv.getRange(2,1,rows.length,2).setValues(rows);
  /* Next shift → Acuity, then clear Next + Nurse */
  var updates=data.map(function(r){ var next=+r[3]||0; return [ next>0?next:r[2], '' ]; });
  sc.getRange(3,3,updates.length,1).setValues(updates.map(function(u){ return [u[0]]; }));
  sc.getRange(3,4,updates.length,1).clearContent();
  sc.getRange(3,6,updates.length,1).clearContent().setBackground(null).clearNote();
  ss_toast('Shift saved to Previous. Next charge: check Staff, then Make Assignment.');
}

function clearBoard(){
  var ui=SpreadsheetApp.getUi();
  var resp=ui.alert('Clear the board?','Clears the Nurse column and the Board tab. Scores stay.',ui.ButtonSet.OK_CANCEL);
  if(resp!==ui.Button.OK) return;
  var sc=_sheet(SCORES); var last=sc.getLastRow();
  if(last>=3) sc.getRange(3,6,last-2,1).clearContent().setBackground(null).clearNote();
  var bd=_sheet(BOARD); bd.clear();
  bd.getRange(1,1).setValue('Run EvenShift → ✨ Make Assignment to fill this board.').setFontStyle('italic');
}

/* ── Live warnings: reacts the moment someone edits a Nurse cell by hand ─── */
function onEdit(e){
  try{
    if(!e || !e.range) return;
    var sh=e.range.getSheet();
    if(sh.getName()!==SCORES) return;
    if(e.range.getColumn()!==6 || e.range.getRow()<3) return;
    var cfg=readConfig();
    var rooms=readRooms(false);
    var nurseName=String(e.value||'').trim();
    e.range.setBackground(null).clearNote();
    if(!nurseName) return;
    var st=_sheet(STAFF); var lastS=st.getLastRow();
    var level='RN', found=false;
    if(lastS>=2){ st.getRange(2,1,lastS-1,3).getValues().forEach(function(r){
      if(String(r[0]).trim().toLowerCase()===nurseName.toLowerCase()){ found=true; level=String(r[1]||'RN')||'RN'; } }); }
    var probs=[];
    if(!found) probs.push('"'+nurseName+'" is not on the Staff tab');
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
  }catch(err){ /* never block the edit */ }
}
