'use strict';
const fs=require('node:fs'),path=require('node:path'),dotenv=require('dotenv');
const {createChatStore}=require('./chat-store');
const RULES={PROVIDER_BASE_URL:'url',PROVIDER_API_KEY:'secret',PROVIDER_MODEL:'string',DSML_TOOL_CALL:'bool',NO_TOOL_EXPERIMENT_VARIANT:'variant',PROVIDER_NATIVE_REASONING_EFFORT:'bool',PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS:'bool',PROVIDER_CONTEXT_WINDOW_TOKENS:'int?',PROVIDER_MAX_INPUT_TOKENS:'int?',PROVIDER_MAX_OUTPUT_TOKENS:'int?',PROVIDER_MODEL_METADATA_TIMEOUT_MS:'int',PROVIDER_CAPABILITIES_CACHE_MS:'int',CONTEXT_WINDOW_SAFETY_TOKENS:'int',HOST:'host',PORT:'int',GATEWAY_ALLOWED_HOSTS:'list',PROVIDER_MAX_REQUESTS_PER_MINUTE:'int',PROVIDER_MAX_CONCURRENT_REQUESTS:'int',PROVIDER_TIMEOUT_MS:'int',MAX_PROVIDER_RETRIES:'int',STREAM_PING_INTERVAL_MS:'int',MAX_BODY_BYTES:'int',MAX_OUTPUT_CHARS:'int',MAX_PROMPT_CHARS:'int',COMPACTION_MAX_INPUT_TOKENS:'int',COMPACTION_MAX_OUTPUT_TOKENS:'int',COMPACTION_MAX_SYSTEM_CHARS:'int',MAX_PENDING_REQUESTS:'int',MAX_RECOVERY_ATTEMPTS:'int',CORS_ALLOWED_ORIGINS:'list',LOG_CAPTURE_CONTENT:'bool',LOG_MAX_FILE_BYTES:'int',LOG_ROTATION_FILES:'int'};
function validate(k,v){const t=RULES[k];if(!t)throw Error('Unsupported configuration key: '+k);v=String(v??'').trim();if(v.length>4096)throw Error(k+' is too long.');if(t==='secret'||t==='string'||t==='list')return v;if(t==='bool'){if(!['true','false'].includes(v.toLowerCase()))throw Error(k+' must be true or false.');return v.toLowerCase()}if(t==='variant'){if(!['A','B'].includes(v))throw Error(k+' must be A or B.');return v}if(t==='int?'&&v==='')return '';if(t==='int'||t==='int?'){if(!/^\d+$/.test(v))throw Error(k+' must be an integer.');const n=Number(v);const bounds={PROVIDER_CONTEXT_WINDOW_TOKENS:[1,10000000],PROVIDER_MAX_INPUT_TOKENS:[1,10000000],PROVIDER_MAX_OUTPUT_TOKENS:[1,10000000],PROVIDER_MODEL_METADATA_TIMEOUT_MS:[500,30000],PROVIDER_CAPABILITIES_CACHE_MS:[1000,86400000],CONTEXT_WINDOW_SAFETY_TOKENS:[0,1000000],PORT:[1,65535],PROVIDER_MAX_REQUESTS_PER_MINUTE:[0,1000000],PROVIDER_MAX_CONCURRENT_REQUESTS:[0,128],PROVIDER_TIMEOUT_MS:[1000,3600000],MAX_PROVIDER_RETRIES:[0,3],STREAM_PING_INTERVAL_MS:[1000,60000],MAX_BODY_BYTES:[1024,134217728],MAX_OUTPUT_CHARS:[1024,20971520],MAX_PROMPT_CHARS:[8192,8000000],COMPACTION_MAX_INPUT_TOKENS:[1024,1000000],COMPACTION_MAX_OUTPUT_TOKENS:[256,200000],COMPACTION_MAX_SYSTEM_CHARS:[1024,100000],MAX_PENDING_REQUESTS:[1,128],MAX_RECOVERY_ATTEMPTS:[0,5],LOG_MAX_FILE_BYTES:[1024,104857600],LOG_ROTATION_FILES:[0,20]};const range=bounds[k]||[0,134217728];if(!Number.isSafeInteger(n)||n<range[0]||n>range[1])throw Error(k+' must be between '+range[0]+' and '+range[1]+'.');return String(n)}if(t==='url'){if(!v)return '';let u;try{u=new URL(v)}catch{throw Error('Provider URL is invalid.')}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Provider URL must use HTTP(S), without embedded credentials.');return v.replace(/\/+$/,'')}if(t==='host'){if(!/^[a-zA-Z0-9.:[\]-]+$/.test(v))throw Error('HOST must be a hostname or IP address.');return v}throw Error('Invalid value for '+k)}
function createDashboardService(o={}){const root=path.resolve(o.rootDir||path.join(__dirname,'..')),file=path.join(root,'.env');function getConfig(){let p={};try{p=dotenv.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}const values={};for(const k of Object.keys(RULES))if(k!=='PROVIDER_API_KEY')values[k]=p[k]||'';return{values,provider_api_key_configured:Boolean(p.PROVIDER_API_KEY)}}function saveConfig(input){if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Expected configuration object.');const updates={};for(const[k,v]of Object.entries(input)){if(k==='PROVIDER_API_KEY'&&String(v??'').trim()==='')continue;updates[k]=validate(k,v)}if(!Object.keys(updates).length)throw Error('No changes supplied.');let old='';try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('.env must be a regular file.');old=fs.readFileSync(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}const seen=new Set(),lines=old?old.split(/\r?\n/).map(line=>{const m=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);if(!m||!(m[1]in updates))return line;if(seen.has(m[1]))return null;seen.add(m[1]);return m[1]+'='+JSON.stringify(updates[m[1]])}).filter(x=>x!==null):[];for(const[k,v]of Object.entries(updates))if(!seen.has(k))lines.push(k+'='+JSON.stringify(v));const temp=path.join(root,'.env.dashboard-'+process.pid+'-'+Date.now()),fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,lines.join('\n').replace(/\n*$/,'\n'));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}try{fs.renameSync(temp,file);fs.chmodSync(file,0o600)}catch(e){try{fs.unlinkSync(temp)}catch{}throw e}return{updated_keys:Object.keys(updates),restart_required:true}}return{getConfig,saveConfig}}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
async function read(req,limit=65536){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw Object.assign(Error('Payload too large.'),{statusCode:413});chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(Error('Invalid JSON body.'),{statusCode:400})}}
function createDashboardHandler(o={}){
 const svc=o.service||createDashboardService(o);
 const chat=o.chatStore||createChatStore(o);
 const root=path.resolve(o.rootDir||path.join(__dirname,'..'));
 const csp={"Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self';"};
 function html(res,file){const body=fs.readFileSync(path.join(root,'public',file),'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',...csp,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(body);return true}
 function fail(res,error){send(res,error.statusCode||400,{ok:false,error:String(error.message||error).slice(0,300)});return true}
 return async(req,res)=>{
  const route=new URL(req.url||'/','http://localhost').pathname;
  if(req.method==='GET'&&['/dashboard','/dashboard/'].includes(route))return html(res,'dashboard.html');
  if(req.method==='GET'&&route==='/dashboard/chat')return html(res,'chat.html');
  if(route==='/chat/sessionid'&&req.method==='POST'){
   try{return send(res,201,{ok:true,session:chat.createSession(await read(req))})}catch(e){return fail(res,e)}
  }
  if(route==='/dashboard/api/config'){
   if(req.method==='GET'){send(res,200,svc.getConfig());return true}
   if(req.method==='POST'){try{send(res,200,{ok:true,...svc.saveConfig(await read(req))})}catch(e){fail(res,e)}return true}
   return false;
  }
  if(route==='/dashboard/api/sessions'){
   if(req.method==='GET'){send(res,200,{data:chat.listSessions()});return true}
   if(req.method==='POST'){try{send(res,201,{ok:true,session:chat.createSession(await read(req))})}catch(e){fail(res,e)}return true}
   return false;
  }
  const match=route.match(/^\/dashboard\/api\/sessions\/([A-Za-z0-9_-]+)(?:\/(messages|summary))?$/);
  if(!match)return false;
  const id=match[1],sub=match[2]||'';
  if(!sub&&req.method==='GET'){
   const session=chat.getSession(id);if(!session){send(res,404,{error:'Session not found.'});return true}
   send(res,200,{session});return true;
  }
  if(!sub&&req.method==='PATCH'){
   try{const session=chat.updateSession(id,await read(req));if(!session){send(res,404,{error:'Session not found.'});return true}send(res,200,{ok:true,session});}
   catch(e){fail(res,e)}return true;
  }
  if(!sub&&req.method==='DELETE'){
   if(!chat.deleteSession(id)){send(res,404,{error:'Session not found.'});return true}
   send(res,200,{ok:true});return true;
  }
  if(sub==='messages'&&req.method==='POST'){
   try{const message=chat.addMessage(id,await read(req,262144));if(!message){send(res,404,{error:'Session not found.'});return true}send(res,201,{ok:true,message});}
   catch(e){fail(res,e)}return true;
  }
  if(sub==='summary'&&req.method==='POST'){
   try{const body=await read(req,262144);const session=chat.saveSummary(id,body.summary,body.through_message_id);if(!session){send(res,404,{error:'Session not found.'});return true}send(res,200,{ok:true,session});}
   catch(e){fail(res,e)}return true;
  }
  return false;
 };
}
module.exports={RULES,validate,createDashboardService,createDashboardHandler};