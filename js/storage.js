// SpendWell storage & auth layer.
//
// Two persistence modes, picked at boot from js/config.js:
//  - Cloud (Supabase configured): email/password accounts, one JSONB state row
//    per user in public.user_state, protected by Row Level Security. Works
//    across devices; optimistic "rev" counter detects concurrent writers.
//  - Local fallback (no config): the original v1 behaviour — AES-GCM vault in
//    localStorage behind a passphrase. Single browser only.

const CFG = window.SPENDWELL_CONFIG || {};
const CLOUD = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && /^https:\/\//.test(CFG.SUPABASE_URL));
const sb = CLOUD ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
let CLOUD_USER = null;      // supabase user when signed in
let _rev = 0;               // rev of the row we last loaded (0 = no row yet)
let _cloudOk = true;        // last cloud save succeeded
let _lastPull = 0;

let STATE = {transactions:[], categories:[], rules:{}, sheet:null};
const STORE_KEY = "spendwell.v1";    // legacy plaintext (migrated on first unlock / first cloud login)
const VAULT_KEY = "spendwell.vault"; // encrypted local store
const CRYPTO_OK = !!(window.crypto && window.crypto.subtle);
const VAULT_ITER_NEW = 310000;       // for new vaults; existing envelopes record their own count
let CRYPTO_KEY = null, VAULT_SALT = null, VAULT_ITER = VAULT_ITER_NEW;
let _saving = false, _dirty = false, _retryTimer = null;
let canPersist = true;
function storageOK(){try{localStorage.setItem("__t","1");localStorage.removeItem("__t");return true;}catch(e){return false;}}

// type:"income" collects positive amounts; type:"excluded" (transfers between
// own accounts etc.) is kept out of spending/income totals, charts and budgets.
// "general" is the fallback bucket and always sits just before the excluded ones.
const DEFAULT_CATEGORIES = [
  {id:"income",name:"Income",color:"#2F7D52",budget:0,type:"income"},
  {id:"holidays",name:"Holidays",color:"#3D6E8C",budget:0},
  {id:"eating-out",name:"Eating Out",color:"#C2703D",budget:0},
  {id:"education",name:"Education",color:"#8A5BB0",budget:0},
  {id:"groceries",name:"Groceries",color:"#3E6B4F",budget:0},
  {id:"gym-fitness",name:"Gym & Fitness",color:"#4F9D94",budget:0},
  {id:"hair-care",name:"Hair Care",color:"#A14E78",budget:0},
  {id:"transport",name:"Transport",color:"#5C6B8A",budget:0},
  {id:"fuel",name:"Fuel",color:"#B58A2E",budget:0},
  {id:"car-insurance",name:"Car Insurance",color:"#7A6A3A",budget:0},
  {id:"car-loan",name:"Car Loan",color:"#9C4F5B",budget:0},
  {id:"subscriptions",name:"Subscriptions",color:"#9C6B4A",budget:0},
  {id:"bills",name:"Bills",color:"#B23A2E",budget:0},
  {id:"entertainment",name:"Entertainment",color:"#5B8AB0",budget:0},
  {id:"supplements",name:"Supplements",color:"#4F9D6B",budget:0},
  {id:"savings",name:"Savings",color:"#4C8577",budget:0},
  {id:"expenses",name:"Expenses",color:"#6B7A8C",budget:0},
  {id:"general",name:"General",color:"#8C8A82",budget:0},
  {id:"excluded",name:"Excluded",color:"#A8A49B",budget:0,type:"excluded"},
  {id:"transfer",name:"Transfer",color:"#BBB7AC",budget:0,type:"excluded"},
];
function defaultState(){return {transactions:[],categories:JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),rules:{},sheet:null};}
// migrate legacy /yr budgets: an annual pot becomes the equivalent monthly
// amount with Rolling on (the closest behaviour now that budgets are monthly
// with optional per-month overrides)
function normalizeCategories(){
  for(const c of STATE.categories){
    if(c.budgetUnit==="year"){
      const annual=+c.budget||0;
      c.budget=Math.round(annual/12*100)/100;
      if(annual>0)c.rolling=true;
    }
    delete c.budgetUnit;
  }
}
function adoptState(d){
  STATE={transactions:d.transactions||[],categories:(d.categories&&d.categories.length?d.categories:JSON.parse(JSON.stringify(DEFAULT_CATEGORIES))),rules:d.rules||{},sheet:d.sheet||null};
  normalizeCategories();
  sortTxns();
}

// ----- local vault crypto
const b64=(buf)=>btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64=(str)=>Uint8Array.from(atob(str),c=>c.charCodeAt(0));
async function deriveKey(pass,salt,iter){
  const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:iter,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function encryptState(){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},CRYPTO_KEY,new TextEncoder().encode(JSON.stringify(STATE)));
  return JSON.stringify({v:2,it:VAULT_ITER,salt:b64(VAULT_SALT),iv:b64(iv),data:b64(ct)});
}

// ----- save pipeline: serialized, always-latest (persistence is async, so
// guard against out-of-order writes); failed cloud saves retry automatically
function saveState(){_dirty=true;flushSave();}
async function flushSave(){
  if(_saving)return;_saving=true;
  try{
    while(_dirty){
      _dirty=false;
      const ok=await persistOnce();
      if(!ok){_dirty=true;clearTimeout(_retryTimer);_retryTimer=setTimeout(flushSave,4000);break;}
    }
  }finally{_saving=false;}
}
async function persistOnce(){
  if(CLOUD){
    if(!CLOUD_USER) return true; // nothing to persist while signed out
    try{await cloudSave();if(!_cloudOk){_cloudOk=true;renderControls();}return true;}
    catch(e){if(_cloudOk){_cloudOk=false;renderControls();}return false;}
  }
  if(CRYPTO_KEY){
    try{const env=await encryptState();localStorage.setItem(VAULT_KEY,env);}catch(e){canPersist=false;}
    return true;
  }
  if(canPersist){try{localStorage.setItem(STORE_KEY,JSON.stringify(STATE));}catch(e){canPersist=false;}}
  return true;
}

// ----- cloud persistence (Supabase)
async function cloudSave(){
  if(_rev===0){
    const {data,error}=await sb.from("user_state").insert({user_id:CLOUD_USER.id,state:STATE}).select("rev").single();
    if(error){
      if(error.code==="23505"){ // row created by another device in the meantime
        await cloudLoad();render();toast("Synced changes from another device");return;
      }
      throw error;
    }
    _rev=data.rev;
    return;
  }
  const {data,error}=await sb.from("user_state")
    .update({state:STATE,rev:_rev+1,updated_at:new Date().toISOString()})
    .eq("user_id",CLOUD_USER.id).eq("rev",_rev).select("rev");
  if(error)throw error;
  if(!data.length){ // someone else wrote first — their version wins, tell the user
    await cloudLoad();render();toast("Synced changes from another device");
    return;
  }
  _rev=data[0].rev;
}
async function cloudLoad(){
  const {data,error}=await sb.from("user_state").select("state,rev").maybeSingle();
  if(error)throw error;
  _lastPull=Date.now();
  if(data){adoptState(data.state);_rev=data.rev;return;}
  _rev=0;
  // first sign-in: pick up any legacy plaintext data left in this browser
  let legacy=null;try{legacy=JSON.parse(localStorage.getItem(STORE_KEY));}catch(e){}
  if(legacy&&Array.isArray(legacy.transactions)&&legacy.transactions.length){
    adoptState(legacy);saveState();
    try{localStorage.removeItem(STORE_KEY);}catch(e){}
    toast("Imported the data saved in this browser");
  }else{
    STATE=defaultState();
  }
}
// if another device changed the data while this tab was hidden, pick it up
async function maybeRefresh(){
  if(!CLOUD||!CLOUD_USER||_dirty||_saving)return;
  if(Date.now()-_lastPull<60000)return;
  _lastPull=Date.now();
  try{
    const {data}=await sb.from("user_state").select("rev").maybeSingle();
    if(data&&data.rev!==_rev){await cloudLoad();render();toast("Updated from another device");}
  }catch(e){}
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")maybeRefresh();});

// ----- cloud auth (Supabase handles hashing, sessions and token refresh)
async function authSignIn(email,pass){
  const {data,error}=await sb.auth.signInWithPassword({email,password:pass});
  if(error)return {error:error.message};
  return {session:data.session};
}
async function authSignUp(email,pass){
  const {data,error}=await sb.auth.signUp({email,password:pass});
  if(error)return {error:error.message};
  return {session:data.session,needsConfirm:!data.session};
}
async function authReset(email){
  const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
  return error?{error:error.message}:{};
}
async function authChangePassword(pass){
  const {error}=await sb.auth.updateUser({password:pass});
  return error?{error:error.message}:{};
}
async function authSignOut(){
  try{await sb.auth.signOut();}catch(e){}
  CLOUD_USER=null;_rev=0;STATE=defaultState();
  $("app").innerHTML="";$("controls").innerHTML="";
  showAuth("signin");
}
async function enterApp(session){
  CLOUD_USER=session.user;
  lockOverlay('<div class="lock-logo serif">S</div><p class="muted" style="font-size:14px">Loading your data…</p>');
  try{await cloudLoad();}
  catch(e){lockOverlay('<div class="lock-logo serif">S</div><p style="color:var(--danger);font-size:14px">Couldn\'t load your data. Check the Supabase schema is installed (see README), then reload.</p>');return;}
  hideLock();startApp();
}

// ----- local vault unlock / setup / re-key (local mode only)
async function unlock(pass){
  let env;try{env=JSON.parse(localStorage.getItem(VAULT_KEY));}catch(e){return false;}
  if(!env)return false;
  const salt=unb64(env.salt), iter=env.it||150000; // v1 envelopes predate the stored count
  let key;try{key=await deriveKey(pass,salt,iter);}catch(e){return false;}
  try{
    const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(env.iv)},key,unb64(env.data));
    adoptState(JSON.parse(new TextDecoder().decode(pt)));
    CRYPTO_KEY=key;VAULT_SALT=salt;VAULT_ITER=iter;return true;
  }catch(e){return false;}   // GCM auth failure => wrong passphrase
}
async function setupPassphrase(pass,migrate){
  VAULT_SALT=crypto.getRandomValues(new Uint8Array(16));
  VAULT_ITER=VAULT_ITER_NEW;
  CRYPTO_KEY=await deriveKey(pass,VAULT_SALT,VAULT_ITER);
  if(migrate){let d=null;try{d=JSON.parse(localStorage.getItem(STORE_KEY));}catch(e){}d?adoptState(d):(STATE=defaultState());}
  else STATE=defaultState();
  saveState();
  try{localStorage.removeItem(STORE_KEY);}catch(e){}
}
async function changePassphrase(pass){
  VAULT_SALT=crypto.getRandomValues(new Uint8Array(16));
  VAULT_ITER=VAULT_ITER_NEW;
  CRYPTO_KEY=await deriveKey(pass,VAULT_SALT,VAULT_ITER);
  saveState();
}

// ----- boot (called from app.js once everything is defined)
function boot(){
  canPersist=storageOK();
  if(CLOUD){bootCloud();return;}
  // local fallback — original v1 flow
  if(!CRYPTO_OK){ // no Web Crypto (e.g. plain http): run unlocked on legacy plaintext
    let d=null;try{d=JSON.parse(localStorage.getItem(STORE_KEY));}catch(e){}
    d?adoptState(d):(STATE=defaultState());
    render();toast("Secure lock needs https — running unlocked here. Deploy over https to enable encryption.",true);
    const s=STATE.sheet;if(s&&s.url&&s.map&&s.autoSync!==false)syncSheet();return;
  }
  if(!canPersist){STATE=defaultState();showLock("setup");return;}
  if(localStorage.getItem(VAULT_KEY)) showLock("unlock");
  else if(localStorage.getItem(STORE_KEY)) showLock("migrate");
  else showLock("setup");
}
async function bootCloud(){
  sb.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY")openNewPassword();
  });
  let session=null;
  try{const r=await sb.auth.getSession();session=r.data.session;}catch(e){}
  if(session)enterApp(session);
  else showAuth("signin");
}
