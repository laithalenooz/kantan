import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const SID = randomUUID();
const base = ["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--model","haiku","--permission-mode","bypassPermissions"];

function run(args, text) {
  return new Promise((res) => {
    const p = spawn("claude", args, { stdio: ["pipe","pipe","pipe"] });
    let buf = "", out = [];
    p.stdout.on("data", d => {
      buf += d; const ls = buf.split("\n"); buf = ls.pop();
      for (const l of ls) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.type === "assistant") out.push("TEXT: " + JSON.stringify(m.message?.content).slice(0,200));
        if (m.type === "result") { out.push(`RESULT sid=${m.session_id} turns=${m.num_turns}`); p.stdin.end(); }
      }
    });
    p.stderr.on("data", d => out.push("ERR: " + String(d).slice(0,200)));
    p.on("exit", c => { out.push("exit=" + c); res(out); });
    p.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:[{type:"text",text}]}}) + "\n");
  });
}

console.log("--- PROBE C: spawn with --session-id, exit, then --resume ---");
console.log("requested session-id:", SID);
console.log((await run([...base,"--session-id",SID], "Remember the codeword BANANA42. Reply 'ok'.")).join("\n"));
console.log("--- resuming ---");
console.log((await run([...base,"--resume",SID], "What was the codeword? Answer with just the word.")).join("\n"));
