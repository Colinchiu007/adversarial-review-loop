#!/usr/bin/env node
'use strict';
const mc = require('./model-call.js');
const fs = require('fs');

function main() {
  const proposalFile = process.argv[2] || 'D:/Data/projects/multi-agent-work/.adversarial/e2e-real-test/proposal-v1.md';
  const proposal = fs.readFileSync(proposalFile, 'utf8');
  console.log('=== Critic Test ===');
  console.log('Proposal length:', proposal.length, 'chars');
  console.log('Calling critic via claude...');
  const r = mc.callCritic({
    backend: 'claude', roundN: 1, proposalText: proposal,
    workdir: 'D:/Data/projects/multi-agent-work', wrapperPath: mc.DEFAULT_WRAPPER,
    timeoutMs: 180000, retryCount: 0
  });
  console.log('Result ok:', r.ok);
  if (r.ok) {
    console.log('Issues:', (r.data.issues||[]).length);
    console.log('Scores:', JSON.stringify(r.data.dimensionScores));
  } else {
    console.log('Error:', r.error);
    if (r.validationErrors) console.log('Validation:', JSON.stringify(r.validationErrors));
    if (r.raw) console.log('Raw:', r.raw.substring(0, 800));
  }
}
main();
