#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");

function log(msg) {
  console.log(`\x1b[36m[google-flow-mcp]\x1b[0m ${msg}`);
}

// No runtime dependencies: mcp_server.py and server.py are standard library only.
// What this checks is that the interpreter a user already has can run them.
try {
  execSync("python3 -c \"import json,urllib.request,http.server,threading\"", { stdio: "ignore", timeout: 5000 });
  log("Python 3 ready — nothing to install");
} catch {
  try {
    execSync("python -c \"import json,urllib.request,http.server,threading\"", { stdio: "ignore", timeout: 5000 });
    log("Python 3 ready (python) — nothing to install");
  } catch {
    log("Python 3 not found. Install it, then: npx google-flow-mcp");
  }
}

log("Next: load veo-automation-extension/ in your browser and run: python3 server.py");