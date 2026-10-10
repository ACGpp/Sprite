#!/usr/bin/env node
// Isolated integration engine: generation one ignores abort/TERM long enough
// to probe revoked gateway access; generation two completes immediately.
import fs from 'node:fs';
import net from 'node:net';
// Test captures belong to the fixture, even when pi runs from isolated runtime cwd.
if (process.env.SPRITE_MEMORY_HOME) process.chdir(process.env.SPRITE_MEMORY_HOME);

const startsFile = 'generation-starts.jsonl';
const previous = fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let previousAlive = false;
try { if (previous.at(-1)?.pid) { process.kill(previous.at(-1).pid, 0); previousAlive = true; } } catch {}
const generation = process.env.SPRITE_AGENT_GENERATION;
fs.appendFileSync(startsFile, JSON.stringify({pid:process.pid,generation,previousAlive,args:process.argv.slice(2)})+'\n');
const first = previous.length === 0;
if (first) process.on('SIGTERM', () => {});
function emit(value) { process.stdout.write(JSON.stringify(value)+'\n'); }
function probe(kind, extra) {
 return new Promise(resolve => {
  const socket = net.createConnection(process.env.SPRITE_GATEWAY_SOCK);
  let buffer = '';
  socket.on('connect',()=>socket.write(JSON.stringify({kind,generation,...extra})+'\n'));
  socket.on('data', chunk => {
   buffer += chunk;
   if (buffer.includes('\n')) {
    fs.appendFileSync('gateway-during-abort.jsonl',JSON.stringify({kind,...JSON.parse(buffer.split('\n')[0])})+'\n');
    socket.destroy(); resolve();
   }
  });
  socket.on('error', error=>{ fs.appendFileSync('gateway-during-abort.jsonl',JSON.stringify({kind,error:error.message})+'\n'); resolve(); });
 });
}
let buffer = '';
process.stdin.on('data', chunk => {
 buffer += chunk;
 let index;
 while ((index = buffer.indexOf('\n')) >= 0) {
  const request = JSON.parse(buffer.slice(0,index)); buffer = buffer.slice(index+1);
  emit({type:'response',id:request.id,success:true});
  if (request.type === 'prompt') {
   fs.appendFileSync('generation-prompts.jsonl',JSON.stringify({generation,pid:process.pid,message:request.message})+'\n');
   if (first) setTimeout(()=>fs.writeFileSync('OLD_GENERATION_SIDE_EFFECT','not cancelled'),1500);
   else emit({type:'agent_end',messages:[]});
  }
  if (request.type === 'abort') {
   void Promise.all([probe('capability.say',{text:'OLD_GENERATION_GATEWAY_SIDE_EFFECT'}),probe('tool.authorize',{tool:'read'})]).then(()=>setTimeout(()=>emit({type:'agent_end',messages:[]}),100));
  }
 }
});
