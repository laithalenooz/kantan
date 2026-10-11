import { spawn } from "node:child_process";
const base = ["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions"];

function run(label, args, text, cwd) {
  return new Promise((res) => {
    const p = spawn("claude", args, { stdio:["pipe","pipe","pipe"], cwd });
    let buf = "";
    console.log(`\n########## ${label} ##########`);
    p.stdout.on("data", d => {
      buf += d; const ls = buf.split("\n"); buf = ls.pop();
      for (const l of ls) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.type === "system" && String(m.subtype||"").startsWith("hook")) continue;
        if (m.type === "system") { console.log(`[system/${m.subtype}]`); continue; }
        if (m.type === "assistant") {
          for (const c of m.message?.content ?? []) {
            if (c.type === "text") console.log("TEXT:", c.text.slice(0,400).replace(/\n/g," | "));
            if (c.type === "tool_use") console.log("TOOL_USE:", c.name, JSON.stringify(c.input).slice(0,300));
            if (c.type === "thinking") console.log("THINKING(len)", c.thinking?.length);
          }
          continue;
        }
        if (m.type === "user") {
          for (const c of m.message?.content ?? []) {
            if (c.type === "tool_result") console.log("TOOL_RESULT:", (typeof c.content === "string" ? c.content : JSON.stringify(c.content)).slice(0,300), "is_error=", c.is_error);
          }
          continue;
        }
        if (m.type === "result") { console.log(`RESULT subtype=${m.subtype} turns=${m.num_turns} cost=${m.total_cost_usd} is_error=${m.is_error}`); console.log("RESULT.result:", String(m.result||"").slice(0,500).replace(/\n/g," | ")); p.stdin.end(); }
        else console.log(`[${m.type}]`, JSON.stringify(m).slice(0,250));
      }
    });
    p.stderr.on("data", d => console.log("STDERR:", String(d).slice(0,300)));
    p.on("exit", c => { console.log("exit=", c); res(); });
    p.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:[{type:"text",text}]}}) + "\n");
  });
}

// PROBE B: force AskUserQuestion in headless mode
await run("PROBE B — AskUserQuestion headless",
  [...base,"--model","haiku"],
  "Use the AskUserQuestion tool right now to ask me whether I prefer tabs or spaces. Do not answer it yourself, just call the tool.",
  process.argv[2]);

// PROBE A: does /superpowers:writing-plans load, and how does the turn end?
await run("PROBE A — writing-plans headless",
  [...base,"--model","sonnet"],
  "/superpowers:writing-plans Task T1 from docs/features/slugger.md: make slug() strip punctuation and collapse spaces to dashes. Write the plan to docs/plans/test-plan.md.",
  process.argv[2]);
