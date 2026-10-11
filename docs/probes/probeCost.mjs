import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const SID = randomUUID();
const base = ["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--model","haiku","--permission-mode","bypassPermissions"];
function run(args, text) {
  return new Promise(res => {
    const p = spawn("claude", args, { stdio:["pipe","pipe","pipe"] });
    let buf = "";
    p.stdout.on("data", d => { buf += d; const ls = buf.split("\n"); buf = ls.pop();
      for (const l of ls) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.type === "result") { console.log(`  subtype=${m.subtype} cost=${m.total_cost_usd} turns=${m.num_turns} usage_in=${m.usage?.input_tokens} is_error=${m.is_error}`); p.stdin.end(); } } });
    p.on("exit", c => res(c));
    p.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:[{type:"text",text}]}}) + "\n");
  });
}
console.log("A) fresh process, --session-id:");
await run([...base,"--session-id",SID], "Write a haiku about caching. Then say DONE.");
console.log("B) resumed process (does cost continue or reset?):");
await run([...base,"--resume",SID], "Write another haiku about disks. Then say DONE.");
console.log("C) resumed with --max-budget-usd 0.0001 (does it bound session or process?):");
const code = await run([...base,"--resume",SID,"--max-budget-usd","0.0001"], "Write a long essay about filesystems, at least 500 words.");
console.log("   exit code:", code);
