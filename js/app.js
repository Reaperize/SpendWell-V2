// SpendWell UI & domain logic. Depends on js/storage.js (loaded first) for
// STATE, persistence and auth. All scripts are classic globals on purpose —
// the UI is rendered as HTML strings with inline handlers.

const $ = (id) => document.getElementById(id);
const GBP = new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"});
// privacy toggle: every monetary display funnels through fmt/fmtShort, so
// masking here hides amounts app-wide (device-local preference, not synced)
let hideAmounts=false; try{hideAmounts=localStorage.getItem("spendwell.hideAmounts")==="1";}catch(e){}
const MASK="£••••";
const fmt = (n)=>hideAmounts?MASK:GBP.format(n||0);
const fmtShort = (n)=>{if(hideAmounts)return MASK;const a=Math.abs(n||0);return a>=1000?"£"+(n/1000).toFixed(1).replace(/\.0$/,"")+"k":"£"+Math.round(n||0);};
function toggleAmounts(){
  hideAmounts=!hideAmounts;
  try{localStorage.setItem("spendwell.hideAmounts",hideAmounts?"1":"0");}catch(e){}
  render();
}
const esc = (s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const monthLabel = (ym)=>{if(!ym)return"";const[y,m]=ym.split("-");return new Date(y,m-1).toLocaleDateString("en-GB",{month:"long",year:"numeric"});};
// parse YYYY-MM-DD as a LOCAL date — new Date("YYYY-MM-DD") is UTC and can
// display as the previous day in timezones behind UTC
const localDate=(s)=>{const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d||1);};

let view="dashboard", month=null, year=null, period="month", search="", filterCat="all";
let customFrom=null, customTo=null; // YYYY-MM-DD bounds for the "Custom" period
let donutChart=null, trendChart=null, budgetTimer=null;

function toast(msg,isErr){
  $("toastRoot").innerHTML='<div class="toast'+(isErr?" err":"")+'">'+esc(msg)+'</div>';
  setTimeout(()=>{$("toastRoot").innerHTML="";},3000);
}
const catById = ()=>Object.fromEntries(STATE.categories.map(c=>[c.id,c]));
function timeAgo(ts){if(!ts)return"";const s=Math.floor((Date.now()-ts)/1000);if(s<90)return"just now";const m=Math.floor(s/60);if(m<60)return m+"m ago";const h=Math.floor(m/60);if(h<24)return h+"h ago";return Math.floor(h/24)+"d ago";}

// ----- categorisation (runs in-browser when you import)
const KEYWORDS={
  income:["salary","payroll","wages","hmrc","refund","interest","dividend","bonus","reimburse","cashback","payment received"],
  groceries:["tesco","sainsbury","asda","aldi","lidl","morrison","waitrose","co-op","coop","iceland","ocado","marks & spencer","m&s","spar","budgens","farmfoods"],
  "eating-out":["nando","mcdonald","kfc","burger king","pizza","domino","deliveroo","uber eats","ubereats","just eat","justeat","greggs","pret","costa","starbucks","cafe","caffe","restaurant","kitchen","grill","kebab","sushi","wagamama","five guys","leon","itsu","tantuni"],
  fuel:["shell","bp ","esso","texaco","petrol","fuel","gulf "],
  transport:["tfl","transport for london","uber","bolt.eu","trainline","national rail","lner","gwr","avanti","thameslink","parking","ringgo","addison lee","lime","dvla","dart charge","congestion"],
  subscriptions:["netflix","spotify","disney","now tv","icloud","apple.com","itunes","amazon prime","prime video","youtube premium","audible","patreon"],
  bills:["octopus energy","british gas","edf","e.on","eon","ovo","thames water","vodafone","ee "," o2","three ","sky ","virgin media","bt ","plusnet","council tax","tv licen"],
  "car-insurance":["admiral","aviva","direct line","churchill","hastings","insurance"],
  "gym-fitness":["gym","puregym","pure gym","fitness","virgin active","third space","john reed","classpass","bjj","jiu"],
  supplements:["myprotein","holland & barrett","vitamin","protein","bulk "],
  "hair-care":["barber","hair","salon"],
  holidays:["hotel","airbnb","booking.com","hostel","ryanair","easyjet","jet2","british airways","wizz","expedia","flight"],
  education:["udemy","coursera","skillshare","tuition","course"],
  entertainment:["cinema","vue","odeon","cineworld","picturehouse","theatre","ticketmaster","steam","playstation","psn","xbox","nintendo","eventbrite","dice"],
  transfer:["transfer"],
};
// subscriptions/bills before transport: "netflix" contains "tfl", so the more
// specific merchant lists must win before short codes like tfl get a chance
const CAT_ORDER=["income","groceries","eating-out","subscriptions","bills","fuel","car-insurance","gym-fitness","supplements","entertainment","holidays","education","hair-care","transport","transfer"];
function merchantKey(desc){return (desc||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim().slice(0,18);}
function autoCategorise(desc,amount){
  const key=merchantKey(desc);
  if(STATE.rules[key])return STATE.rules[key];
  const d=(desc||"").toLowerCase();
  if(amount>0){for(const w of KEYWORDS.transfer)if(d.includes(w))return "transfer";return "income";}
  for(const cat of CAT_ORDER){if(cat==="income")continue;for(const w of KEYWORDS[cat])if(d.includes(w))return cat;}
  return "general";
}
// categories whose transactions don't count as spending or income (transfers etc.)
function excludedSet(){return new Set(STATE.categories.filter(c=>c.type==="excluded").map(c=>c.id));}
const isBudgetable=(c)=>c.type!=="income"&&c.type!=="excluded";

// newest first, by transaction date (import id breaks ties). Master order is
// what every list renders from, so imports/syncs stay sorted too.
function sortTxns(){STATE.transactions.sort((a,b)=>a.date===b.date?(b.id||0)-(a.id||0):(a.date<b.date?1:-1));}

function deriveMonths(){
  const set=new Set(STATE.transactions.map(t=>t.date.slice(0,7)));
  const arr=[...set].sort().reverse();
  if(!month||!arr.includes(month)) month=arr[0]||null;
  return arr;
}
function deriveYears(){
  const set=new Set(STATE.transactions.map(t=>t.date.slice(0,4)));
  const arr=[...set].sort().reverse();
  if(!year||!arr.includes(year)) year=arr[0]||null;
  return arr;
}
// contiguous YYYY-MM list from first to last data month (fills gaps so rolling budgets accrue through quiet months)
function monthsList(){
  const ms=[...new Set(STATE.transactions.map(t=>t.date.slice(0,7)))].sort();
  if(!ms.length) return [];
  const out=[]; let [y,m]=ms[0].split("-").map(Number); const last=ms[ms.length-1];
  for(let i=0;i<1200;i++){const k=y+"-"+String(m).padStart(2,"0");out.push(k);if(k===last)break;m++;if(m>12){m=1;y++;}}
  return out;
}
function spentByMonthCat(catId){const map={};for(const t of STATE.transactions)if(t.amount<0&&t.category===catId){const k=t.date.slice(0,7);map[k]=(map[k]||0)+(-t.amount);}return map;}
function periodBounds(){
  const all=monthsList(); if(!all.length) return {months:[],before:[],count:0};
  let months;
  if(period==="all") months=all.slice();
  else if(period==="year") months=all.filter(k=>k.slice(0,4)===year);
  else if(period==="custom"&&customFrom&&customTo) months=all.filter(k=>k>=customFrom.slice(0,7)&&k<=customTo.slice(0,7));
  else months=all.filter(k=>k===month);
  const start=months[0];
  const before=start?all.slice(0,all.indexOf(start)):[];
  return {months,before,count:months.length};
}
function periodTxns(){
  if(period==="all") return STATE.transactions;
  if(period==="year") return STATE.transactions.filter(t=>t.date.slice(0,4)===year);
  if(period==="custom"&&customFrom&&customTo) return STATE.transactions.filter(t=>t.date>=customFrom&&t.date<=customTo);
  return STATE.transactions.filter(t=>t.date.slice(0,7)===month);
}
// first and last day of quarter q (1-4) in year y, as YYYY-MM-DD
function quarterRange(y,q){
  const lastM=q*3, lastD=new Date(+y,lastM,0).getDate();
  return [y+"-"+String(q*3-2).padStart(2,"0")+"-01", y+"-"+String(lastM).padStart(2,"0")+"-"+String(lastD).padStart(2,"0")];
}
function periodLabel(){
  if(period==="all") return "All time";
  if(period==="year") return year||"";
  if(period==="custom"){
    if(!customFrom||!customTo) return "Custom range";
    const y=customFrom.slice(0,4);
    for(let q=1;q<=4;q++){const[f,t]=quarterRange(y,q);if(f===customFrom&&t===customTo)return "Q"+q+" "+y;}
    const fm=(d)=>localDate(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
    return fm(customFrom)+" – "+fm(customTo);
  }
  return monthLabel(month);
}
// ----- budgets are monthly with optional per-month overrides (c.months maps
// month number 1-12 to an amount, repeating every year — e.g. an annual
// premium in March). Rolling carries unspent budget across months WITHIN a
// calendar year only (resets each year).
function monthOverride(c,mNum){
  if(!c.months)return null;
  const v=c.months[mNum]!=null?c.months[mNum]:c.months[String(mNum)];
  return v==null||v===""?null:(+v||0);
}
function monthBudget(c,mNum){const o=monthOverride(c,mNum);return o!=null?o:(+c.budget||0);}
function hasOverrides(c){for(let m=1;m<=12;m++)if(monthOverride(c,m)!=null)return true;return false;}
function annualBudget(c){let a=0;for(let m=1;m<=12;m++)a+=monthBudget(c,m);return a;}
function yearsWithData(){return [...new Set(STATE.transactions.map(t=>t.date.slice(0,4)))];}
function categoryTarget(c){
  const annual=annualBudget(c), sm=spentByMonthCat(c.id);
  if(period==="all"){
    const years=yearsWithData().length||1;
    const spent=Object.values(sm).reduce((a,v)=>a+v,0);
    const target=annual*years;
    return {target,spent,carryIn:0,remaining:target-spent,rolling:!!c.rolling};
  }
  if(period==="year"){
    const spent=monthsList().reduce((a,k)=>a+(k.slice(0,4)===year?(sm[k]||0):0),0);
    return {target:annual,spent,carryIn:0,remaining:annual-spent,rolling:!!c.rolling};
  }
  if(period==="custom"){
    if(!customFrom||!customTo) return {target:0,spent:0,carryIn:0,remaining:0,rolling:false};
    // sum each overlapped month's budget, prorated by the days covered
    let target=0,[y,m]=customFrom.slice(0,7).split("-").map(Number);
    const endKey=customTo.slice(0,7);
    for(let i=0;i<1200;i++){
      const key=y+"-"+String(m).padStart(2,"0"), dim=new Date(y,m,0).getDate();
      const a=key===customFrom.slice(0,7)?+customFrom.slice(8,10):1;
      const b=key===endKey?+customTo.slice(8,10):dim;
      target+=monthBudget(c,m)*(b-a+1)/dim;
      if(key===endKey)break;
      m++;if(m>12){m=1;y++;}
    }
    let spent=0;for(const t of STATE.transactions)if(t.amount<0&&t.category===c.id&&t.date>=customFrom&&t.date<=customTo)spent+=-t.amount;
    return {target,spent,carryIn:0,remaining:target-spent,rolling:false};
  }
  // month view
  const Y=month.slice(0,4), mNum=+month.slice(5,7);
  const spent=sm[month]||0;
  let carryIn=0;
  if(c.rolling){
    const before=monthsList().filter(k=>k.slice(0,4)===Y && k<month);
    const beforeAlloc=before.reduce((a,k)=>a+monthBudget(c,+k.slice(5,7)),0);
    const beforeSpent=before.reduce((a,k)=>a+(sm[k]||0),0);
    carryIn=beforeAlloc-beforeSpent; // never looks before January, so no cross-year carry
  }
  const target=monthBudget(c,mNum)+carryIn;
  return {target,spent,carryIn,remaining:target-spent,rolling:!!c.rolling};
}
function stats(){
  let spent=0,income=0; const byCat={}, excl=excludedSet();
  for(const t of periodTxns()){
    if(excl.has(t.category))continue; // transfers/excluded are neither spending nor income
    if(t.amount>0) income+=t.amount;
    else{spent+=-t.amount;byCat[t.category]=(byCat[t.category]||0)+-t.amount;}
  }
  let totalBudget=0;
  for(const c of STATE.categories){if(!isBudgetable(c))continue;totalBudget+=categoryTarget(c).target;}
  return{spent,income,byCat,totalBudget};
}

// ----- data actions
function setCat(id,cat){
  const t=STATE.transactions.find(x=>x.id==id);
  if(t){STATE.rules[merchantKey(t.description)]=cat;t.category=cat;saveState();}
  render();
}
function applyMerchant(desc,cat){
  const key=merchantKey(desc);STATE.rules[key]=cat;
  for(const t of STATE.transactions)if(merchantKey(t.description)===key)t.category=cat;
  saveState();render();toast("Applied to all matching");
}
function saveCategories(){clearTimeout(budgetTimer);budgetTimer=setTimeout(saveState,300);}
function setBudget(id,val){
  const n=parseFloat(val);
  STATE.categories=STATE.categories.map(c=>c.id===id?{...c,budget:isNaN(n)?0:n}:c);
  saveCategories();
  // update the row in place — re-rendering the tab here would destroy the
  // input mid-typing and drop focus after every keystroke
  const c=STATE.categories.find(x=>x.id===id);
  const info=$("budinfo-"+id);if(info&&c)info.innerHTML=budgetInfoHtml(c);
  const sum=$("budSumLine");if(sum)sum.innerHTML=budgetTotalsHtml();
}

// ----- backup / restore
function exportData(){
  const blob=new Blob([JSON.stringify(STATE,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download="spendwell-backup-"+new Date().toISOString().slice(0,10)+".json";
  a.click();URL.revokeObjectURL(a.href);toast("Backup downloaded");
}
function openRestore(){$("restoreInput").click();}
$("restoreInput").addEventListener("change",e=>{const f=e.target.files[0];e.target.value="";if(!f)return;
  const r=new FileReader();r.onload=()=>{try{const d=JSON.parse(r.result);if(!d||!Array.isArray(d.transactions))throw 0;STATE={transactions:d.transactions,categories:(d.categories&&d.categories.length?d.categories:STATE.categories),rules:d.rules||{},sheet:d.sheet||STATE.sheet||null};normalizeCategories();sortTxns();saveState();month=null;render();toast("Backup restored");}catch(_){toast("That file isn't a SpendWell backup",true);}};r.readAsText(f);});

// ----- start fresh / clear data
function openClear(){
  modal(`<div class="modal-pad">
    <div class="serif" style="font-size:20px;margin-bottom:6px">Start fresh</div>
    <p class="muted" style="font-size:13px;margin:0 0 16px">This can't be undone — consider downloading a backup first.</p>
    <div style="display:grid;gap:10px">
      <button class="btn btn-ghost" onclick="exportData()">↓ Download a backup first</button>
      <button class="btn btn-ghost" style="justify-content:flex-start;text-align:left" onclick="clearData('txns')"><span><b>Clear transactions</b><br><span class="muted" style="font-weight:500;font-size:12.5px">Keep my categories &amp; budgets</span></span></button>
      <button class="btn btn-ghost" style="justify-content:flex-start;text-align:left;color:var(--danger)" onclick="clearData('all')"><span><b>Reset everything</b><br><span class="muted" style="font-weight:500;font-size:12.5px">Transactions, categories &amp; budgets back to defaults</span></span></button>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  </div>`);
}
function clearData(mode){
  if(mode==="all"){
    if(!confirm("Reset everything to defaults? This removes all transactions, categories and budgets.")) return;
    STATE=defaultState();
  } else {
    STATE.transactions=[];
  }
  try{localStorage.removeItem(STORE_KEY);}catch(e){}
  saveState();
  month=null;year=null;period="month";view="dashboard";search="";filterCat="all";
  closeModal();render();
  toast(mode==="all"?"Everything reset — starting fresh":"Transactions cleared");
}

// ----- modal plumbing
function modal(html){$("modalRoot").innerHTML='<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal">'+html+'</div></div>';}
function closeModal(){$("modalRoot").innerHTML="";}

// ----- CSV / sheet import
function guessCatCol(fields){
  return fields.find(f=>/^(category|categories|cat|tag|tags|group)$/i.test(String(f).trim()))
      || fields.find(f=>String(f).toLowerCase().includes("categor"))
      || "";
}
function openCsv(){$("csvInput").click();}
$("csvInput").addEventListener("change",e=>{const f=e.target.files[0];e.target.value="";if(f)parseCsv(f);});
function parseCsv(file){
  Papa.parse(file,{header:true,skipEmptyLines:true,complete:res=>{
    const fields=(res.meta.fields||[]).filter(Boolean);
    const rows=res.data.filter(r=>Object.values(r).some(v=>v!==""));
    const guess=(w)=>fields.find(f=>w.some(x=>f.toLowerCase().includes(x)))||"";
    const hasOut=guess(["paid out","money out","debit","withdraw"]),hasIn=guess(["paid in","money in","credit","deposit"]);
    window._csv={file:file.name,fields,rows,dateCol:guess(["date"]),descCol:guess(["description","detail","narrative","reference","memo","payee","name","merchant","transaction"]),catCol:guessCatCol(fields),mode:hasOut&&hasIn?"split":"single",amountCol:guess(["amount","value"]),outCol:hasOut,inCol:hasIn,sign:"neg"};
    renderCsvModal();
  },error:()=>toast("Couldn't read that CSV",true)});
}
function csvPreview(cfg,limit){
  const out=[];
  for(const row of cfg.rows){
    const date=parseDate(row[cfg.dateCol]);const desc=(row[cfg.descCol]||"").toString().trim();let amount=null;
    if(cfg.mode==="split"){const o=parseAmt(row[cfg.outCol]),i=parseAmt(row[cfg.inCol]);if(i&&i!==0)amount=Math.abs(i);else if(o&&o!==0)amount=-Math.abs(o);}
    else{const v=parseAmt(row[cfg.amountCol]);if(v!==null)amount=cfg.sign==="neg"?v:-v;}
    const category=cfg.catCol?String(row[cfg.catCol]==null?"":row[cfg.catCol]).trim():"";
    if(date&&amount!==null&&amount!==0)out.push({date,description:desc,amount,category:category||null});
    if(limit&&out.length>=limit)break;
  }return out;
}
function parseDate(raw){if(!raw)return null;const s=String(raw).trim();let m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);if(m)return m[1]+"-"+m[2].padStart(2,"0")+"-"+m[3].padStart(2,"0");m=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);if(m){let[,d,mo,y]=m;if(y.length===2)y="20"+y;return y+"-"+mo.padStart(2,"0")+"-"+d.padStart(2,"0");}const t=Date.parse(s);if(!isNaN(t)){const dt=new Date(t);return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");}return null;}
function parseAmt(raw){if(raw==null||raw==="")return null;let s=String(raw).trim();let neg=false;if(/^\(.*\)$/.test(s)){neg=true;s=s.slice(1,-1);}if(s.includes("-"))neg=true;s=s.replace(/[^0-9.]/g,"");if(s==="")return null;const n=parseFloat(s);if(isNaN(n))return null;return neg?-n:n;}
function renderCsvModal(){
  const c=window._csv;const opt=(sel)=>c.fields.map(f=>`<option ${f===sel?"selected":""}>${esc(f)}</option>`).join("");
  const prev=csvPreview(c,4);
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px"><div class="serif" style="font-size:21px">Map your columns</div><button class="x" onclick="closeModal()">×</button></div>
    <p class="muted" style="font-size:13px;margin:0 0 18px"><b>${esc(c.file)}</b> · ${c.rows.length} rows</p>
    <div class="grid-2" style="margin-bottom:16px">
      <div><label class="field-label">Date column</label><select class="select" style="width:100%" onchange="window._csv.dateCol=this.value;renderCsvModal()"><option value="">—</option>${opt(c.dateCol)}</select></div>
      <div><label class="field-label">Description column</label><select class="select" style="width:100%" onchange="window._csv.descCol=this.value;renderCsvModal()"><option value="">—</option>${opt(c.descCol)}</select></div>
      <div><label class="field-label">Category column (optional)</label><select class="select" style="width:100%" onchange="window._csv.catCol=this.value;renderCsvModal()"><option value="">— auto-categorise</option>${opt(c.catCol)}</select></div>
      <div style="align-self:end"><p class="muted" style="font-size:12px;margin:0;line-height:1.5">If your file has a category column, those categories are used as-is — new ones are created automatically.</p></div>
    </div>
    <label class="field-label">How are amounts stored?</label>
    <div class="radio" style="margin-bottom:16px">
      <button class="btn ${c.mode==="single"?"btn-primary":"btn-ghost"}" onclick="window._csv.mode='single';renderCsvModal()">One amount column</button>
      <button class="btn ${c.mode==="split"?"btn-primary":"btn-ghost"}" onclick="window._csv.mode='split';renderCsvModal()">Separate in / out</button>
    </div>
    ${c.mode==="single"?
      `<div class="grid-2" style="margin-bottom:18px">
        <div><label class="field-label">Amount column</label><select class="select" style="width:100%" onchange="window._csv.amountCol=this.value;renderCsvModal()"><option value="">—</option>${opt(c.amountCol)}</select></div>
        <div><label class="field-label">Spending shows as</label><div class="radio">
          <button class="btn ${c.sign==="neg"?"btn-primary":"btn-ghost"}" style="flex:1" onclick="window._csv.sign='neg';renderCsvModal()">Negative −</button>
          <button class="btn ${c.sign==="pos"?"btn-primary":"btn-ghost"}" style="flex:1" onclick="window._csv.sign='pos';renderCsvModal()">Positive +</button>
        </div></div></div>`:
      `<div class="grid-2" style="margin-bottom:18px">
        <div><label class="field-label">Money out column</label><select class="select" style="width:100%" onchange="window._csv.outCol=this.value;renderCsvModal()"><option value="">—</option>${opt(c.outCol)}</select></div>
        <div><label class="field-label">Money in column</label><select class="select" style="width:100%" onchange="window._csv.inCol=this.value;renderCsvModal()"><option value="">—</option>${opt(c.inCol)}</select></div>
      </div>`}
    <div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:20px">
      <div class="field-label" style="margin-bottom:8px">Preview</div>
      ${prev.length?`<table class="prev"><thead><tr><th>Date</th><th>Description</th>${c.catCol?"<th>Category</th>":""}<th style="text-align:right">Amount</th></tr></thead><tbody>${prev.map(p=>`<tr><td>${p.date}</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.description)}</td>${c.catCol?`<td>${p.category?esc(p.category):'<span class="muted">auto</span>'}</td>`:""}<td style="text-align:right;font-weight:600;color:${p.amount>0?"var(--positive)":"var(--ink)"}">${fmt(p.amount)}</td></tr>`).join("")}</tbody></table>`:'<div class="muted" style="font-size:13px">No valid rows yet — check the columns above.</div>'}
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" ${prev.length?"":"disabled"} onclick="confirmCsv()">Import transactions</button>
    </div></div>`);
}
function ingestRows(rows){
  const existing=new Set(STATE.transactions.map(t=>t.uid));
  let added=0,created=0,maxId=STATE.transactions.reduce((m,t)=>Math.max(m,t.id||0),0);
  for(const r of rows){
    const uid="csv|"+r.date+"|"+r.amount+"|"+(r.description||"");
    if(existing.has(uid))continue;existing.add(uid);
    // imported category wins; blank/missing falls back to rules + keywords
    let cat=null;
    if(r.category){
      const f=findCatByName(r.category);
      if(f)cat=f.id;else{cat=createCategoryFromName(r.category);created++;}
    }
    if(!cat)cat=autoCategorise(r.description,r.amount);
    if(!catById()[cat])cat=ensureFallback();
    STATE.transactions.push({id:++maxId,uid,date:r.date,description:r.description||"",amount:r.amount,category:cat});
    added++;
  }
  sortTxns();
  if(added||created)saveState();
  return {added,created};
}
function importToastMsg(res,fromSheet){
  if(!res.added)return fromSheet?"Up to date — nothing new":"No new transactions (all already imported)";
  let m=(fromSheet?"Synced — ":"Imported ")+res.added+" transaction"+(res.added>1?"s":"");
  if(res.created)m+=" · "+res.created+" new categor"+(res.created>1?"ies":"y");
  return m;
}
function confirmCsv(){
  const cfg=window._csv;const rows=csvPreview(cfg);closeModal();
  const res=ingestRows(rows);
  if(cfg.sheet&&STATE.sheet){
    STATE.sheet.map={dateCol:cfg.dateCol,descCol:cfg.descCol,catCol:cfg.catCol,mode:cfg.mode,amountCol:cfg.amountCol,outCol:cfg.outCol,inCol:cfg.inCol,sign:cfg.sign};
    STATE.sheet.lastSync=Date.now();saveState();
  }
  month=null;render();
  toast(res.added||!cfg.sheet?importToastMsg(res,cfg.sheet):"Connected — no new transactions yet");
}

// ----- Google Sheet auto-sync (reads an Apps Script web-app endpoint returning {fields, rows})
async function fetchSheet(url){
  let r;try{r=await fetch(url,{redirect:"follow"});}catch(e){throw {net:true};}
  if(!r.ok) throw {status:r.status};
  let data;try{data=await r.json();}catch(e){throw {bad:true};}
  if(!data||!Array.isArray(data.rows)||!Array.isArray(data.fields)) throw {bad:true};
  return data;
}
function sheetErr(e){
  if(e&&e.bad) return "Reached the sheet, but the response wasn't the expected JSON. Check the Apps Script returns {fields, rows}.";
  if(e&&e.status) return "The endpoint returned an error ("+e.status+"). Make sure the deployment access is set to ‘Anyone’.";
  return "Couldn't reach the sheet. Check the Apps Script is deployed as a web app with access ‘Anyone’ and the URL ends in /exec. (You can always use Import CSV instead.)";
}
function buildCfg(data,map){
  const fields=data.fields||[], rows=data.rows||[];
  // saved maps from before category support get the category column guessed in
  if(map) return {fields,rows,...map,catCol:map.catCol!==undefined?map.catCol:guessCatCol(fields)};
  const guess=(w)=>fields.find(f=>w.some(x=>String(f).toLowerCase().includes(x)))||"";
  const hasOut=guess(["paid out","money out","debit","withdraw","outflow","spent"]),hasIn=guess(["paid in","money in","credit","deposit","inflow","received"]);
  return {file:"Google Sheet",fields,rows,dateCol:guess(["date","time"]),descCol:guess(["description","detail","narrative","reference","memo","payee","name","merchant","transaction","note"]),catCol:guessCatCol(fields),mode:hasOut&&hasIn?"split":"single",amountCol:guess(["amount","value","total"]),outCol:hasOut,inCol:hasIn,sign:"neg"};
}
function openSheet(){
  const s=STATE.sheet||{};
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px"><div class="serif" style="font-size:21px">Google Sheet sync</div><button class="x" onclick="closeModal()">×</button></div>
    <p class="muted" style="font-size:13px;margin:0 0 16px">Paste the web-app URL from your Apps Script deployment. SpendWell pulls new transactions straight from the sheet${CLOUD?"":" — your data stays in this browser"}. If the sheet has a category column, those categories are used automatically. Treat the URL like a password.</p>
    <label class="field-label">Apps Script web-app URL</label>
    <input class="input" id="sheetUrl" style="width:100%;margin-bottom:12px" placeholder="https://script.google.com/macros/s/AKfy.../exec" value="${esc(s.url||"")}"/>
    <label class="tg ${s.autoSync!==false?"on":""}" id="autoTg" onclick="this.classList.toggle('on')" style="margin-bottom:18px"><span class="sw"></span>Sync automatically when I open the app</label>
    <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap">
      ${s.url?`<button class="btn btn-ghost" style="color:var(--danger)" onclick="disconnectSheet()">Disconnect</button>`:`<span></span>`}
      <div style="display:flex;gap:10px"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="connectSheet()">Connect &amp; sync</button></div>
    </div>
    <div id="sheetMsg" style="margin-top:12px;font-size:13px"></div>
  </div>`);
}
async function connectSheet(){
  const url=($("sheetUrl").value||"").trim();
  const auto=$("autoTg").classList.contains("on");
  if(!/^https:\/\//.test(url)){$("sheetMsg").innerHTML='<span style="color:var(--danger)">Paste the full https:// web-app URL (it ends in /exec).</span>';return;}
  $("sheetMsg").innerHTML='<span class="muted">Connecting…</span>';
  try{
    const data=await fetchSheet(url);
    const keepMap=(STATE.sheet&&STATE.sheet.url===url)?STATE.sheet.map:null;
    STATE.sheet={url,autoSync:auto,map:keepMap,lastSync:(STATE.sheet&&STATE.sheet.url===url)?STATE.sheet.lastSync:null};
    saveState();
    const cfg=buildCfg(data,keepMap);cfg.sheet=true;cfg.file="Google Sheet";window._csv=cfg;
    renderCsvModal();
  }catch(e){$("sheetMsg").innerHTML='<span style="color:var(--danger)">'+esc(sheetErr(e))+'</span>';}
}
async function syncSheet(){
  const s=STATE.sheet;if(!s||!s.url){openSheet();return;}
  toast("Syncing from Google Sheet…");
  try{
    const data=await fetchSheet(s.url);
    const res=ingestRows(csvPreview(buildCfg(data,s.map)));
    s.lastSync=Date.now();saveState();month=null;render();
    toast(importToastMsg(res,true));
  }catch(e){toast(sheetErr(e),true);}
}
function disconnectSheet(){STATE.sheet=null;saveState();closeModal();renderControls();toast("Google Sheet disconnected");}

// ----- category management
const SWATCHES=["#3E6B4F","#C2703D","#3D6E8C","#A14E78","#7A6A3A","#8A5BB0","#4F9D94","#9C6B4A","#B23A2E","#2F7D52","#5C6B8A","#B58A2E"];
function slugifyName(name){return name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"")+"-"+Math.random().toString(36).slice(2,5);}
function findCatByName(name){const k=String(name==null?"":name).trim().toLowerCase();if(!k)return null;return STATE.categories.find(c=>c.name.trim().toLowerCase()===k)||null;}
// insert new categories just before the fallback/excluded block without
// disturbing any custom order the user has set
function insertCategory(cat){
  const i=STATE.categories.findIndex(c=>c.id==="general"||c.id==="other"||c.type==="excluded");
  if(i<0)STATE.categories.push(cat);
  else STATE.categories.splice(i,0,cat);
}
function createCategoryFromName(name){
  const clean=String(name).trim().slice(0,40);
  const id=slugifyName(clean);
  const cat={id,name:clean,color:SWATCHES[STATE.categories.length%SWATCHES.length],budget:0};
  // sheet categories named like transfers/exclusions get the non-counting behaviour
  if(/^(excluded?|exclusions?|transfers?)$/i.test(clean))cat.type="excluded";
  insertCategory(cat);
  return id;
}
function ensureFallback(){
  if(!STATE.categories.some(c=>c.id==="general"))STATE.categories.push({id:"general",name:"General",color:"#8C8A82",budget:0});
  return "general";
}
function swatchHtml(sel){
  const list=SWATCHES.includes(sel)?SWATCHES:(sel?[sel,...SWATCHES]:SWATCHES);
  return `<div id="swatches" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">${list.map(s=>`<button data-c="${s}" onclick="pickColor('${s}')" style="width:30px;height:30px;border-radius:8px;background:${s};cursor:pointer;border:${s===sel?"3px solid var(--ink)":"2px solid transparent"}"></button>`).join("")}</div>`;
}
function pickColor(c){window._newColor=c;document.querySelectorAll("#swatches button").forEach(b=>b.style.border=b.dataset.c===c?"3px solid var(--ink)":"2px solid transparent");}
function openAddCat(){
  window._newColor=SWATCHES[0];
  modal(`<div class="modal-pad">
    <div class="serif" style="font-size:19px;margin-bottom:14px">New category</div>
    <input class="input" id="catName" placeholder="e.g. Travel, Subscriptions, Pets" style="margin-bottom:14px"/>
    ${swatchHtml(SWATCHES[0])}
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="addCat()">Add</button></div>
  </div>`);
}
function addCat(){
  const name=$("catName").value.trim();if(!name)return;
  if(findCatByName(name)){toast("There's already a category with that name",true);return;}
  insertCategory({id:slugifyName(name),name,color:window._newColor,budget:0});
  saveState();closeModal();render();
}
// ----- reorder categories by dragging (income stays pinned first; order
// drives the budgets page and every category dropdown, and syncs with state).
// Pointer events instead of HTML5 drag-and-drop so it works on touchscreens.
function openReorder(){
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px"><div class="serif" style="font-size:19px">Reorder categories</div><button class="x" onclick="closeModal()">×</button></div>
    <p class="muted" style="font-size:13px;margin:0 0 12px">Drag the ⠿ handle to change the order shown on the Budgets page and in category dropdowns.</p>
    <div id="reorderList">${reorderRows()}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn btn-primary" onclick="closeModal();render()">Done</button></div>
  </div>`);
  initReorderDrag();
}
function reorderRows(){
  return STATE.categories.filter(c=>c.type!=="income").map(c=>`<div class="drag-row" data-id="${c.id}">
    <span class="drag-handle" title="Drag to reorder">⠿</span>
    <span class="dot" style="background:${c.color}"></span>
    <span style="flex:1;min-width:0;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}${c.type==="excluded"?' <span class="muted" style="font-size:11px;font-weight:600">excluded</span>':""}</span>
  </div>`).join("");
}
function initReorderDrag(){
  const list=$("reorderList");if(!list)return;
  const scroller=list.closest(".modal");
  list.addEventListener("pointerdown",(e)=>{
    const handle=e.target.closest(".drag-handle");if(!handle)return;
    const row=handle.closest(".drag-row");if(!row)return;
    e.preventDefault();
    row.classList.add("dragging");
    const move=(ev)=>{
      const y=ev.clientY;
      // auto-scroll the modal when dragging near its edges
      if(scroller){const sr=scroller.getBoundingClientRect();if(y<sr.top+44)scroller.scrollTop-=9;else if(y>sr.bottom-44)scroller.scrollTop+=9;}
      // slide the row into the slot the pointer is over
      let next=null;
      for(const o of list.querySelectorAll(".drag-row:not(.dragging)")){
        const r=o.getBoundingClientRect();
        if(y<r.top+r.height/2){next=o;break;}
      }
      if(next)list.insertBefore(row,next);else list.appendChild(row);
    };
    const up=()=>{
      row.classList.remove("dragging");
      document.removeEventListener("pointermove",move);
      document.removeEventListener("pointerup",up);
      document.removeEventListener("pointercancel",up);
      applyReorder();
    };
    document.addEventListener("pointermove",move);
    document.addEventListener("pointerup",up);
    document.addEventListener("pointercancel",up);
  });
}
function applyReorder(){
  const ids=[...document.querySelectorAll("#reorderList .drag-row")].map(el=>el.dataset.id);
  if(!ids.length)return;
  const map=catById();
  const income=STATE.categories.filter(c=>c.type==="income");
  const ordered=ids.map(id=>map[id]).filter(Boolean);
  if(ordered.length+income.length!==STATE.categories.length)return; // never drop a category
  STATE.categories=[...income,...ordered];
  saveState();
}
function openEditCat(id){
  const c=STATE.categories.find(x=>x.id===id);if(!c)return;
  window._newColor=c.color;
  const others=STATE.categories.filter(x=>x.id!==id&&x.type!=="income");
  const isIncome=c.type==="income";
  const canDelete=!isIncome&&others.length>0;
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px"><div class="serif" style="font-size:19px">Edit category</div><button class="x" onclick="closeModal()">×</button></div>
    <label class="field-label">Name</label>
    <input class="input" id="catName" value="${esc(c.name)}" style="margin-bottom:14px"/>
    <label class="field-label">Colour</label>
    ${swatchHtml(c.color)}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-bottom:18px"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveCatEdit('${id}')">Save</button></div>
    ${canDelete?`<div style="border-top:1px solid var(--line);padding-top:16px">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:4px;color:var(--danger)">Delete this category</div>
      <p class="muted" style="font-size:12.5px;margin:0 0 10px">Its transactions and merchant rules move to the category you pick below. Its budget is removed.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="muted" style="font-size:12.5px">Move everything to</span>
        <select class="select" id="catMoveTo">${others.map(o=>`<option value="${o.id}" ${o.id==="general"||o.id==="other"?"selected":""}>${esc(o.name)}</option>`).join("")}</select>
        <button class="btn btn-ghost" style="color:var(--danger)" onclick="deleteCat('${id}')">Delete</button>
      </div></div>`
    :`<p class="muted" style="font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;margin:0">${isIncome?"The income category can be renamed but not deleted — incoming payments need somewhere to live.":"Add another spending category before deleting this one."}</p>`}
  </div>`);
}
function saveCatEdit(id){
  const name=$("catName").value.trim();
  if(!name){toast("Give the category a name",true);return;}
  const dup=findCatByName(name);
  if(dup&&dup.id!==id){toast('There\'s already a category called "'+dup.name+'"',true);return;}
  STATE.categories=STATE.categories.map(c=>c.id===id?{...c,name,color:window._newColor||c.color}:c);
  saveState();closeModal();render();toast("Category updated");
}
function deleteCat(id){
  const gone=STATE.categories.find(c=>c.id===id);
  if(!gone||gone.type==="income")return;
  const sel=$("catMoveTo");
  const target=STATE.categories.find(c=>c.id===(sel?sel.value:"general")&&c.id!==id);
  if(!target){toast("Pick a category to move transactions to",true);return;}
  let moved=0;
  for(const t of STATE.transactions)if(t.category===id){t.category=target.id;moved++;}
  for(const k in STATE.rules)if(STATE.rules[k]===id)STATE.rules[k]=target.id;
  STATE.categories=STATE.categories.filter(c=>c.id!==id);
  if(filterCat===id)filterCat="all";
  saveState();closeModal();render();
  toast('Deleted "'+gone.name+'"'+(moved?" — "+moved+" transaction"+(moved>1?"s":"")+" moved to "+target.name:""));
}

// ----- rendering
function renderControls(){
  const n=STATE.transactions.length;
  const sh=STATE.sheet;
  const synced = sh&&sh.url? (sh.lastSync?" · synced "+timeAgo(sh.lastSync):" · sheet connected") : "";
  const saveNote = CLOUD ? (_cloudOk?"":" · cloud save failed — retrying") : (canPersist?"":" · saving is off in this view");
  $("syncStatus").innerHTML = n? (n+" transaction"+(n>1?"s":"")+" tracked"+synced+saveNote) : (sh&&sh.url?"Google Sheet connected — press Sync to pull transactions":"Budgets &amp; spending, beautifully tracked");
  $("controls").innerHTML=`
    ${n?`<button class="btn btn-ghost" onclick="toggleAmounts()" title="${hideAmounts?"Show amounts":"Hide amounts"}">${hideAmounts?"🙈":"👁"}</button>`:""}
    ${CLOUD&&CLOUD_USER?`<button class="btn btn-ghost" onclick="openAccount()" title="Account &amp; security">👤</button>`:""}
    ${!CLOUD&&CRYPTO_KEY?`<button class="btn btn-ghost" onclick="openSecurity()" title="Security &amp; passphrase">🔒</button>`:""}
    ${sh&&sh.url?`<button class="btn btn-ghost" onclick="syncSheet()" title="Pull the latest from your Google Sheet">↻ Sync</button>`:""}
    <button class="btn btn-ghost" onclick="openSheet()" title="Connect a Google Sheet for automatic syncing">⚙</button>
    ${n?`<button class="btn btn-ghost" onclick="exportData()" title="Download a backup of your data">↓ Backup</button>`:""}
    <button class="btn btn-ghost" onclick="openRestore()" title="Restore from a backup file">⟳ Restore</button>
    ${n?`<button class="btn btn-ghost" onclick="openClear()" title="Clear data and start fresh">Clear</button>`:""}
    <button class="btn btn-primary" onclick="openCsv()">↑ Import CSV</button>`;
}
// period bar: the segmented control keeps a fixed spot; the contextual picker
// (month / year / custom dates) lives in its own slot so buttons never shift
function periodBarHtml(){
  const months=deriveMonths(), years=deriveYears();
  const seg=`<div class="seg">${[["month","Month"],["year","Year"],["all","All time"],["custom","Custom"]].map(([v,l])=>`<button class="seg-btn ${period===v?"on":""}" onclick="setPeriod('${v}')">${l}</button>`).join("")}</div>`;
  let sel="";
  if(period==="month") sel=`<select class="select" onchange="month=this.value;render()">${months.map(m=>`<option value="${m}" ${m===month?"selected":""}>${monthLabel(m)}</option>`).join("")}</select>`;
  else if(period==="year") sel=`<select class="select" onchange="year=this.value;render()">${years.map(y=>`<option value="${y}" ${y===year?"selected":""}>${y}</option>`).join("")}</select>`;
  else if(period==="custom"){
    const qOn=(q)=>{const[f,t]=quarterRange(year||"",q);return f===customFrom&&t===customTo;};
    sel=`<select class="select" onchange="setQuarterYear(this.value)" title="Year for the quarter presets">${years.map(y=>`<option value="${y}" ${y===year?"selected":""}>${y}</option>`).join("")}</select>
      ${[1,2,3,4].map(q=>`<button class="unit ${qOn(q)?"on":""}" onclick="setQuarter(${q})">Q${q}</button>`).join("")}
      <input type="date" class="select date-in" value="${customFrom||""}" onchange="setCustomDate('from',this.value)"/>
      <span class="muted" style="font-size:13px">to</span>
      <input type="date" class="select date-in" value="${customTo||""}" onchange="setCustomDate('to',this.value)"/>`;
  }
  else sel=`<span class="muted" style="font-size:13px;padding:6px 0">Showing everything</span>`;
  return `<div class="period-bar">${seg}<div class="period-sel">${sel}</div></div>`;
}
function setPeriod(p){
  period=p;
  if(p==="year")deriveYears();
  if(p==="month")deriveMonths();
  if(p==="custom"&&(!customFrom||!customTo)){
    deriveMonths();
    if(month){const[y,m]=month.split("-").map(Number);customFrom=month+"-01";customTo=month+"-"+String(new Date(y,m,0).getDate()).padStart(2,"0");}
  }
  render();
}
function setQuarter(q){
  period="custom";deriveYears();
  const [f,t]=quarterRange(year||String(new Date().getFullYear()),q);
  customFrom=f;customTo=t;render();
}
function setQuarterYear(v){
  const oldY=year;year=v;
  // if a quarter preset was active, carry it over to the newly picked year
  for(let q=1;q<=4;q++){const[f,t]=quarterRange(oldY,q);if(f===customFrom&&t===customTo){const[nf,nt]=quarterRange(v,q);customFrom=nf;customTo=nt;break;}}
  render();
}
function setCustomDate(which,v){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return;
  period="custom";
  if(which==="from")customFrom=v;else customTo=v;
  if(customFrom&&customTo&&customFrom>customTo){const t=customFrom;customFrom=customTo;customTo=t;}
  render();
}
function toggleRolling(id){STATE.categories=STATE.categories.map(c=>c.id===id?{...c,rolling:!c.rolling}:c);saveState();render();}

function render(){
  renderControls();
  const app=$("app");
  if(STATE.transactions.length===0){app.innerHTML=emptyView();return;}
  app.innerHTML=`${periodBarHtml()}<div class="tabs">${["dashboard","transactions","budgets"].map(v=>`<button class="tab ${v===view?"active":""}" onclick="view='${v}';render()">${v[0].toUpperCase()+v.slice(1)}</button>`).join("")}</div><div id="viewBody" class="fade"></div>`;
  if(view==="dashboard")renderDashboard();
  else if(view==="transactions")renderTransactions();
  else renderBudgets();
}

function emptyView(){
  return `<div class="card empty fade">
    <div class="serif" style="font-size:26px;margin-bottom:10px">Let's get started</div>
    <p class="muted" style="max-width:460px;margin:0 auto 22px;line-height:1.6">Import a CSV from your bank or card, or connect a Google Sheet (e.g. Emma's Live Export) to pull transactions automatically. SpendWell sorts everything into categories so you can set a budget for each.${CLOUD?" Your data is saved to your account and syncs across devices.":""}</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="openCsv()">↑ Import a CSV</button>
      <button class="btn btn-ghost" onclick="openSheet()">⚙ Connect Google Sheet</button>
      <button class="btn btn-ghost" onclick="openRestore()">⟳ Restore a backup</button>
    </div></div>`;
}

function renderDashboard(){
  const s=stats(),cats=catById(),excl=excludedSet();
  const donut=Object.entries(s.byCat).map(([id,value])=>({id,name:cats[id]?cats[id].name:id,value,color:cats[id]?cats[id].color:"#999"})).sort((a,b)=>b.value-a.value);
  const exp=STATE.categories.filter(isBudgetable);
  const pset=new Set(periodBounds().months);
  const trend=(()=>{
    const m={};for(const t of STATE.transactions)if(t.amount<0&&!excl.has(t.category)){const ym=t.date.slice(0,7);m[ym]=(m[ym]||0)+-t.amount;}
    let keys=Object.keys(m).sort();
    if(period==="year") keys=keys.filter(k=>k.slice(0,4)===year);
    keys=keys.slice(-12);
    return keys.map(ym=>({ym,label:localDate(ym+"-01").toLocaleDateString("en-GB",period==="month"?{month:"short"}:{month:"short",year:"2-digit"}).replace(","," "),value:Math.round(m[ym])}));
  })();
  const tgt=Object.fromEntries(exp.map(c=>[c.id,categoryTarget(c)]));
  const prog=exp.filter(c=>annualBudget(c)>0||tgt[c.id].target>0||s.byCat[c.id]);
  $("viewBody").innerHTML=`
    <div class="stats-grid">
      <div class="card"><div class="stat-label">Spent</div><div class="stat-val" style="color:var(--danger)">${fmt(s.spent)}</div></div>
      <div class="card"><div class="stat-label">Income</div><div class="stat-val" style="color:var(--positive)">${fmt(s.income)}</div></div>
      <div class="card"><div class="stat-label">Net</div><div class="stat-val">${fmt(s.income-s.spent)}</div></div>
      <div class="card"><div class="stat-label">Budget left</div><div class="stat-val" style="color:${s.totalBudget-s.spent<0?"var(--danger)":"var(--ink)"}">${s.totalBudget>0?fmt(s.totalBudget-s.spent):"—"}</div>${s.totalBudget>0?`<div class="muted" style="font-size:12.5px;margin-top:3px">of ${fmt(s.totalBudget)} budget</div>`:""}</div>
    </div>
    <div class="dash-grid">
      <div class="card">
        <div class="serif" style="font-size:18px;margin-bottom:2px">Where it went</div>
        <div class="muted" style="font-size:13px;margin-bottom:8px">${periodLabel()}</div>
        ${donut.length?`<div class="chart-box"><canvas id="donut"></canvas><div class="chart-center"><div><div class="muted" style="font-size:11px;font-weight:600">TOTAL</div><div class="serif" style="font-size:22px">${fmtShort(s.spent)}</div></div></div></div>
        <div style="margin-top:14px;display:grid;gap:8px">${donut.map(d=>`<div style="display:flex;align-items:center;gap:9px;font-size:13.5px"><span class="dot" style="background:${d.color}"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span><span style="font-weight:600">${fmt(d.value)}</span></div>`).join("")}</div>`:'<p class="muted" style="font-size:14px">No spending in this period.</p>'}
      </div>
      <div class="card">
        <div class="serif" style="font-size:18px;margin-bottom:14px">Budget progress</div>
        ${prog.length?`<div style="display:grid;gap:15px">${prog.sort((a,b)=>(s.byCat[b.id]||0)-(s.byCat[a.id]||0)).map(c=>{const T=tgt[c.id],sp=T.spent,hasBudget=annualBudget(c)>0,over=hasBudget&&sp>T.target,pct=T.target>0?Math.min(sp/T.target*100,100):((sp>0||T.target<0)?100:0);return `<div><div style="display:flex;justify-content:space-between;gap:8px;font-size:13.5px;margin-bottom:6px"><span style="display:flex;align-items:center;gap:8px;min-width:0"><span class="dot" style="background:${c.color}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>${T.rolling?' <span class="muted" style="font-size:11px" title="Rolling budget">↻</span>':''}</span><span style="color:${over?"var(--danger)":"var(--muted)"};font-weight:600;flex-shrink:0">${fmt(sp)}${T.target>0?` <span class="muted">/ ${fmt(T.target)}</span>`:""}</span></div>${hasBudget?`<div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${over?"var(--danger)":c.color}"></div></div>`:""}</div>`;}).join("")}</div>`:'<p class="muted" style="font-size:14px">Set budgets in the Budgets tab to track progress here.</p>'}
      </div>
    </div>
    ${trend.length>1?`<div class="card" style="margin-top:16px"><div class="serif" style="font-size:18px;margin-bottom:14px">Spending trend</div><div style="height:180px;position:relative"><canvas id="trend"></canvas></div></div>`:""}`;
  if(donutChart){donutChart.destroy();donutChart=null;}
  if(trendChart){trendChart.destroy();trendChart=null;}
  // maintainAspectRatio:false makes the canvas fill .chart-box exactly, which
  // keeps the absolutely-positioned centre label aligned at every viewport size
  if(donut.length){donutChart=new Chart($("donut"),{type:"doughnut",data:{labels:donut.map(d=>d.name),datasets:[{data:donut.map(d=>d.value),backgroundColor:donut.map(d=>d.color),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:"68%",plugins:{legend:{display:false},tooltip:{callbacks:{label:(x)=>" "+fmt(x.raw)}}}}});}
  if(trend.length>1){trendChart=new Chart($("trend"),{type:"bar",data:{labels:trend.map(t=>t.label),datasets:[{data:trend.map(t=>t.value),backgroundColor:trend.map(t=>pset.has(t.ym)?"#2C4A3B":"#C9D4CC"),borderRadius:7}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(x)=>" "+fmt(x.raw)}}},scales:{x:{grid:{display:false},border:{display:false}},y:{display:false}}}});}
}

function renderTransactions(){
  const cats=catById();
  const list=periodTxns().filter(t=>filterCat==="all"||t.category===filterCat).filter(t=>(t.description||"").toLowerCase().includes(search.toLowerCase()));
  $("viewBody").innerHTML=`<div class="card">
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <input class="input" style="flex:1;min-width:180px" placeholder="Search transactions…" value="${esc(search)}" oninput="search=this.value;renderTransactions()"/>
      <select class="select" onchange="filterCat=this.value;renderTransactions()"><option value="all">All categories</option>${STATE.categories.map(c=>`<option value="${c.id}" ${c.id===filterCat?"selected":""}>${esc(c.name)}</option>`).join("")}</select>
    </div>
    ${list.length?list.map(t=>{const c=cats[t.category];return `<div class="txn">
      <span class="dot" style="background:${c?c.color:"#999"}"></span>
      <div class="txn-main"><div style="font-weight:600;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.description)||"—"}</div><div class="muted" style="font-size:12.5px">${localDate(t.date).toLocaleDateString("en-GB",period==="month"?{day:"numeric",month:"short"}:{day:"numeric",month:"short",year:"numeric"})}</div></div>
      <select class="pill" onchange="setCat('${t.id}',this.value)">${STATE.categories.map(cat=>`<option value="${cat.id}" ${cat.id===t.category?"selected":""}>${esc(cat.name)}</option>`).join("")}</select>
      <div class="txn-amt" style="color:${t.amount>0?"var(--positive)":"var(--ink)"}">${t.amount>0?"+":""}${fmt(t.amount)}</div>
    </div>`;}).join(""):'<p class="muted" style="font-size:14px;padding:10px 0">No transactions match.</p>'}
  </div>`;
}

// combined budget across all categories, normalised to monthly + yearly
// (independent of the selected period — this is what's *set*, not spent)
function budgetTotalsHtml(){
  const cats=STATE.categories.filter(isBudgetable);
  const annual=cats.reduce((a,c)=>a+annualBudget(c),0);
  const varies=cats.some(hasOverrides);
  return annual>0?`<b>${fmt(annual/12)}</b><span class="muted">/mo${varies?" avg":""}</span> · <b>${fmt(annual)}</b><span class="muted">/yr</span>`:`<span class="muted">No budgets set yet</span>`;
}
// ----- per-month budget editor
const MONTH_NAMES=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function openMonthBudgets(id){
  const c=STATE.categories.find(x=>x.id===id);if(!c)return;
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px"><div class="serif" style="font-size:19px">Month-specific budgets · ${esc(c.name)}</div><button class="x" onclick="closeModal()">×</button></div>
    <p class="muted" style="font-size:13px;margin:0 0 14px">Leave a month blank to use the default of <b>£${(+c.budget||0)}/mo</b>. Type an amount only for months that differ — e.g. an annual premium in the month it's paid. These repeat every year.</p>
    <div class="mb-grid">${MONTH_NAMES.map((n,i)=>{const o=monthOverride(c,i+1);return `<div><label class="field-label" style="margin-bottom:4px">${n}</label><input class="input mb-in" type="number" min="0" step="any" data-m="${i+1}" value="${o!=null?o:""}" placeholder="${(+c.budget||0)||0}" oninput="updateMbTotal('${id}')"/></div>`;}).join("")}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap">
      <span class="muted" style="font-size:13px">Year total: <b id="mbTotal">${fmt(annualBudget(c))}</b></span>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn btn-ghost" onclick="clearMonthBudgets('${id}')" title="Blank all months (back to the default for every month)">Clear</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveMonthBudgets('${id}')">Save</button>
      </div>
    </div>
  </div>`);
}
function readMbInputs(){
  const months={};
  document.querySelectorAll(".mb-in").forEach(inp=>{
    const v=inp.value.trim();
    if(v!==""){const n=parseFloat(v);if(!isNaN(n)&&n>=0)months[inp.dataset.m]=n;}
  });
  return months;
}
function updateMbTotal(id){
  const c=STATE.categories.find(x=>x.id===id);if(!c)return;
  const months=readMbInputs(), def=+c.budget||0;
  let total=0;for(let m=1;m<=12;m++)total+=months[m]!=null?months[m]:def;
  const el=$("mbTotal");if(el)el.textContent=fmt(total);
}
function saveMonthBudgets(id){
  const months=readMbInputs();
  STATE.categories=STATE.categories.map(c=>{
    if(c.id!==id)return c;
    const n={...c};
    if(Object.keys(months).length)n.months=months;else delete n.months;
    return n;
  });
  saveState();closeModal();render();toast("Monthly amounts saved");
}
function clearMonthBudgets(id){
  document.querySelectorAll(".mb-in").forEach(i=>i.value="");
  updateMbTotal(id);
}

function budgetInfoHtml(c){
  const T=categoryTarget(c),sp=T.spent;
  // "no budget set" only when there really is none — a rolling budget whose
  // carried-over deficit drags the month's target to zero or below still has
  // a budget, and must show as over rather than lose its bar
  if(annualBudget(c)<=0) return `<div style="font-size:12.5px;color:var(--muted)">${sp>0?fmt(sp)+" spent · no budget set":"No budget set"}</div>`;
  const over=sp>T.target;
  const pct=T.target>0?Math.min(sp/T.target*100,100):((sp>0||T.target<0)?100:0);
  return `<div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${over?"var(--danger)":c.color}"></div></div>
    <div style="font-size:12.5px;margin-top:5px;color:${over?"var(--danger)":"var(--muted)"}">${fmt(sp)} spent · ${over?fmt(sp-T.target)+" over":fmt(T.target-sp)+" left"}${period==="month"&&monthOverride(c,+month.slice(5,7))!=null?' · <span class="muted">month-specific budget</span>':""}${period==="month"&&c.rolling&&Math.round(T.carryIn)!==0?` · <span class="muted">${T.carryIn>0?"+"+fmt(T.carryIn)+" rolled in":fmt(T.carryIn)+" rolled in"}</span>`:""}</div>`;
}
function renderBudgets(){
  const exp=STATE.categories.filter(isBudgetable);
  const excl=STATE.categories.filter(c=>c.type==="excluded");
  const exclCount=(id)=>periodTxns().filter(t=>t.category===id).length;
  $("viewBody").innerHTML=`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;gap:10px;flex-wrap:wrap"><div class="serif" style="font-size:18px">Budgets</div><div style="font-size:14px"><span class="muted" style="font-size:12.5px;font-weight:600;margin-right:6px">TOTAL</span><span id="budSumLine">${budgetTotalsHtml()}</span></div></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:18px">
        <details class="hint">
          <summary>How budgets work</summary>
          <p>Each category has a monthly budget; budgets reset each calendar year. Click <b>📅</b> to give specific months their own amount — handy for things paid once a year, like insurance (the button is highlighted when a category has month-specific amounts). Turn on <b>Rolling</b> to carry unspent budget across months within the same year (it won't roll into the next). In a custom date range, targets are prorated by the number of days. Click ✎ to rename, recolour or delete a category.</p>
        </details>
        <span class="muted" style="font-size:12.5px;font-weight:600">${periodLabel()}</span>
      </div>
      <div style="display:grid;gap:18px">${exp.map(c=>`<div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap"><span class="dot" style="background:${c.color}"></span><span style="font-weight:600;font-size:14.5px;flex:1;min-width:110px">${esc(c.name)}</span><button class="edit-cat" onclick="openEditCat('${c.id}')" title="Rename, recolour or delete this category">✎</button>
          <div class="tg ${c.rolling?"on":""}" onclick="toggleRolling('${c.id}')" title="Carry unspent budget across months within the same calendar year"><span class="sw"></span>Rolling</div>
          <span class="muted" style="font-size:13px">£</span><input class="input" style="width:96px;font-weight:600" type="number" min="0" step="any" placeholder="0" value="${(+c.budget||0)||""}" oninput="setBudget('${c.id}',this.value)"/><span class="muted" style="font-size:12px">/mo</span><button class="unit ${hasOverrides(c)?"on":""}" onclick="openMonthBudgets('${c.id}')" title="Set different amounts for specific months — e.g. an annual premium in the month it's paid">📅</button></div>
        <div id="budinfo-${c.id}">${budgetInfoHtml(c)}</div>
      </div>`).join("")}</div>
    </div>
    ${excl.length?`<div class="card" style="margin-top:16px">
      <div style="font-weight:600;font-size:14.5px;margin-bottom:2px">Excluded from budgets</div>
      <div class="muted" style="font-size:13px;margin-bottom:12px">Transactions in these categories (e.g. transfers between your own accounts) don't count towards spending, income, charts or budgets.</div>
      ${excl.map(c=>`<div style="display:flex;align-items:center;gap:10px;padding:7px 0"><span class="dot" style="background:${c.color}"></span><span style="font-weight:600;font-size:14px;flex:1;min-width:110px">${esc(c.name)}</span><span class="muted" style="font-size:12.5px">${exclCount(c.id)} transaction${exclCount(c.id)===1?"":"s"} in ${periodLabel()}</span><button class="edit-cat" onclick="openEditCat('${c.id}')" title="Rename, recolour or delete this category">✎</button></div>`).join("")}
    </div>`:""}
    <div class="card" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><div style="font-weight:600;font-size:14.5px">Manage categories</div><div class="muted" style="font-size:13px">Create your own categories or change the order they appear in.</div></div><div style="display:flex;gap:9px;flex-wrap:wrap"><button class="btn btn-ghost" onclick="openReorder()">⇅ Reorder</button><button class="btn btn-ghost" onclick="openAddCat()">+ New category</button></div></div>
    `;
}

// ----- lock screen (local mode) + auth screens (cloud mode)
function lockOverlay(inner){$("lockRoot").innerHTML='<div class="lock-overlay"><div class="lock-card">'+inner+'</div></div>';}
function hideLock(){$("lockRoot").innerHTML="";}
function showLock(mode){
  const setup = mode!=="unlock";
  lockOverlay(`
    <div class="lock-logo serif">S</div>
    <div class="serif" style="font-size:24px;margin-bottom:6px">${setup?"Protect your data":"Welcome back"}</div>
    <p class="muted" style="font-size:13px;margin:0 0 18px">${setup?(mode==="migrate"?"Set a passphrase — your existing data will be encrypted on this device.":"Set a passphrase to encrypt your data on this device."):"Enter your passphrase to unlock SpendWell."}</p>
    <input class="input" id="passA" type="password" placeholder="Passphrase" autocomplete="${setup?"new-password":"current-password"}" />
    ${setup?`<input class="input" id="passB" type="password" placeholder="Confirm passphrase" autocomplete="new-password" />`:""}
    <div class="lock-err" id="lockErr"></div>
    <button class="btn btn-primary" style="width:100%" id="lockGo">${setup?"Encrypt &amp; continue":"Unlock"}</button>
    ${setup?`<div class="lock-note">Your passphrase is never stored or sent anywhere. If you forget it, the data can't be recovered — only cleared.</div>`:`<button class="lock-link danger" id="lockForgot">Forgot passphrase? Start over</button>`}`);
  const go=()=>setup?doSetup(mode):doUnlock();
  $("lockGo").onclick=go;
  $("passA").addEventListener("keydown",e=>{if(e.key==="Enter"){if(setup&&$("passB"))$("passB").focus();else go();}});
  if($("passB"))$("passB").addEventListener("keydown",e=>{if(e.key==="Enter")go();});
  if($("lockForgot"))$("lockForgot").onclick=()=>{if(confirm("Start over? This permanently erases the encrypted data on this device.")){try{localStorage.removeItem(VAULT_KEY);localStorage.removeItem(STORE_KEY);}catch(e){}CRYPTO_KEY=null;showLock("setup");}};
  setTimeout(()=>{try{$("passA").focus();}catch(e){}},50);
}
async function doSetup(mode){
  const a=$("passA").value,b=$("passB")?$("passB").value:"";
  if(a.length<6){$("lockErr").textContent="Use at least 6 characters.";return;}
  if(a!==b){$("lockErr").textContent="Passphrases don't match.";return;}
  $("lockGo").disabled=true;$("lockErr").textContent="";
  try{await setupPassphrase(a,mode==="migrate");hideLock();startApp();}
  catch(e){$("lockGo").disabled=false;$("lockErr").textContent="Couldn't set up encryption here.";}
}
async function doUnlock(){
  const a=$("passA").value;
  if(!a){$("lockErr").textContent="Enter your passphrase.";return;}
  $("lockGo").disabled=true;$("lockErr").textContent="Checking…";
  const ok=await unlock(a);
  if(ok){hideLock();startApp();}
  else{$("lockGo").disabled=false;$("lockErr").textContent="Incorrect passphrase.";$("passA").value="";$("passA").focus();}
}

function showAuth(mode){
  const title=mode==="signup"?"Create your account":mode==="reset"?"Reset password":"Welcome back";
  const sub=mode==="signup"?"Your budgets sync securely across all your devices.":mode==="reset"?"We'll email you a link to set a new password.":"Sign in to access your budgets on any device.";
  lockOverlay(`
    <div class="lock-logo serif">S</div>
    <div class="serif" style="font-size:24px;margin-bottom:6px">${title}</div>
    <p class="muted" style="font-size:13px;margin:0 0 18px">${sub}</p>
    <input class="input" id="authEmail" type="email" placeholder="Email" autocomplete="email"/>
    ${mode!=="reset"?`<input class="input" id="authPass" type="password" placeholder="Password" autocomplete="${mode==="signup"?"new-password":"current-password"}"/>`:""}
    ${mode==="signup"?`<input class="input" id="authPass2" type="password" placeholder="Confirm password" autocomplete="new-password"/>`:""}
    <div class="lock-err" id="authErr"></div>
    <button class="btn btn-primary" style="width:100%" id="authGo">${mode==="signup"?"Create account":mode==="reset"?"Send reset link":"Sign in"}</button>
    ${mode==="signin"?`<button class="lock-link" onclick="showAuth('reset')">Forgot password?</button>`:`<button class="lock-link" onclick="showAuth('signin')">Back to sign in</button>`}
    <div class="lock-note">Passwords are hashed and verified by Supabase Auth — SpendWell never stores or sees them.</div>`);
  $("authGo").onclick=()=>doAuth(mode);
  const enter=(e)=>{if(e.key==="Enter")doAuth(mode);};
  ["authEmail","authPass","authPass2"].forEach(i=>{const el=$(i);if(el)el.addEventListener("keydown",enter);});
  setTimeout(()=>{try{$("authEmail").focus();}catch(e){}},50);
}
async function doAuth(mode){
  const email=($("authEmail").value||"").trim();
  const fail=(m)=>{$("authErr").textContent=m;$("authGo").disabled=false;};
  const note=(m)=>{$("authErr").innerHTML='<span style="color:var(--positive)">'+esc(m)+'</span>';$("authGo").disabled=false;};
  if(!/^\S+@\S+\.\S+$/.test(email)){fail("Enter a valid email address.");return;}
  $("authGo").disabled=true;$("authErr").textContent="";
  if(mode==="reset"){
    const r=await authReset(email);
    r.error?fail(r.error):note("Check your inbox for the reset link.");
    return;
  }
  const pass=$("authPass").value;
  if(mode==="signup"){
    if(pass.length<8){fail("Use at least 8 characters.");return;}
    if(pass!==$("authPass2").value){fail("Passwords don't match.");return;}
    const r=await authSignUp(email,pass);
    if(r.error){fail(r.error);return;}
    if(r.needsConfirm){note("Almost there — open the confirmation link we emailed you, then sign in.");return;}
    enterApp(r.session);return;
  }
  const r=await authSignIn(email,pass);
  if(r.error){fail(/invalid login/i.test(r.error)?"Wrong email or password.":r.error);return;}
  enterApp(r.session);
}

function openAccount(){
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px"><div class="serif" style="font-size:21px">Account</div><button class="x" onclick="closeModal()">×</button></div>
    <p class="muted" style="font-size:13px;margin:0 0 16px">Signed in as <b>${esc(CLOUD_USER&&CLOUD_USER.email||"")}</b>. Your data is stored in your account — only you can read it.</p>
    <label class="field-label">Change password</label>
    <input class="input" id="npA" type="password" placeholder="New password" style="margin-bottom:8px" autocomplete="new-password"/>
    <input class="input" id="npB" type="password" placeholder="Confirm new password" style="margin-bottom:6px" autocomplete="new-password"/>
    <div class="lock-err" id="npErr"></div>
    <div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap">
      <button class="btn btn-ghost" style="color:var(--danger)" onclick="closeModal();authSignOut()">Sign out</button>
      <div style="display:flex;gap:10px"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="doChangePass()">Update</button></div>
    </div>
  </div>`);
}
function openSecurity(){
  modal(`<div class="modal-pad">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px"><div class="serif" style="font-size:21px">Security</div><button class="x" onclick="closeModal()">×</button></div>
    <p class="muted" style="font-size:13px;margin:0 0 16px">Your data is encrypted on this device with your passphrase.</p>
    <button class="btn btn-ghost" style="width:100%;margin-bottom:18px" onclick="lockNow()">🔒 Lock now</button>
    <label class="field-label">Change passphrase</label>
    <input class="input" id="npA" type="password" placeholder="New passphrase" style="width:100%;margin-bottom:8px" autocomplete="new-password"/>
    <input class="input" id="npB" type="password" placeholder="Confirm new passphrase" style="width:100%;margin-bottom:6px" autocomplete="new-password"/>
    <div class="lock-err" id="npErr"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="doChangePass()">Update</button></div>
  </div>`);
}
function openNewPassword(){
  modal(`<div class="modal-pad">
    <div class="serif" style="font-size:21px;margin-bottom:6px">Set a new password</div>
    <p class="muted" style="font-size:13px;margin:0 0 16px">You followed a reset link — choose a new password for your account.</p>
    <input class="input" id="npA" type="password" placeholder="New password" style="margin-bottom:8px" autocomplete="new-password"/>
    <input class="input" id="npB" type="password" placeholder="Confirm new password" style="margin-bottom:6px" autocomplete="new-password"/>
    <div class="lock-err" id="npErr"></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" onclick="doChangePass()">Save password</button></div>
  </div>`);
}
async function doChangePass(){
  const a=$("npA").value,b=$("npB").value;
  if(CLOUD){
    if(a.length<8){$("npErr").textContent="Use at least 8 characters.";return;}
    if(a!==b){$("npErr").textContent="Passwords don't match.";return;}
    const r=await authChangePassword(a);
    if(r.error){$("npErr").textContent=r.error;return;}
    closeModal();toast("Password updated");
    return;
  }
  if(a.length<6){$("npErr").textContent="Use at least 6 characters.";return;}
  if(a!==b){$("npErr").textContent="Passphrases don't match.";return;}
  await changePassphrase(a);closeModal();toast("Passphrase updated");
}
function lockNow(){CRYPTO_KEY=null;closeModal();$("app").innerHTML="";showLock("unlock");}
function startApp(){
  render();
  if(!CLOUD&&!canPersist) toast("Heads up: this browser is blocking local saving, so use Backup to keep your data.",true);
  const s=STATE.sheet;
  if(s&&s.url&&s.map&&s.autoSync!==false) syncSheet();
}

boot();
