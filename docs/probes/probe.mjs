import { spawn } from "node:child_process";

const p = spawn("claude", [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--model", "haiku",
  "--permission-mode", "bypassPermissions",
], { stdio: ["pipe", "pipe", "pipe"] });

const send = (text) => p.stdin.write(JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
}) + "\n");

let buf = "";
let turns = 0;
p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { console.log("RAW:", l.slice(0,120)); continue; }
    console.log(`[${m.type}${m.subtype ? "/" + m.subtype : ""}]`,
      m.type === "result" ? `turns=${m.num_turns} cost=${m.total_cost_usd} session=${m.session_id}` :
      m.type === "assistant" ? JSON.stringify(m.message?.content)?.slice(0, 160) :
      m.type === "system" ? `cwd=${m.cwd} tools=${m.tools?.length} skills=${(m.slash_commands||[]).length}` : "");
    if (m.type === "result") {
      turns++;
      if (turns === 1) { console.log(">>> SENDING SECOND TURN ON SAME PROCESS"); send("What number did I just ask about? Answer with digits only."); }
      else { p.stdin.end(); }
    }
  }
});
p.stderr.on("data", d => console.error("ERR:", String(d).slice(0,300)));
p.on("exit", c => console.log("exit", c));

send("Reply with just the number 7, nothing else.");
