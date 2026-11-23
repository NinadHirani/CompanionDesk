'use strict';

// Offline retrieval-quality eval: recall@k and MRR for the fixture corpus.
const fs = require('fs');
const path = require('path');
const { buildIndex, selectForTask } = require('./lib/rank');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/corpus.json'), 'utf8'));
const queries = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/queries.json'), 'utf8'));
const index = buildIndex(corpus);

let sumRecall = 0; let sumMRR = 0; let n = 0;
const rows = [];
for (const { q, expect, task } of queries) {
  const got = selectForTask(index, q, task, { includeSensitive: true }).map((r) => r.id);
  const hits = expect.filter((id) => got.includes(id));
  const recall = hits.length / expect.length;
  let mrr = 0;
  for (const id of expect) {
    const rank = got.indexOf(id) + 1;
    if (rank > 0) { mrr = Math.max(mrr, 1 / rank); break; }
  }
  rows.push({ q, task, expect: expect.join(','), got: got.join(','), recall: recall.toFixed(2), mrr: mrr.toFixed(2) });
  sumRecall += recall; sumMRR += mrr; n += 1;
}
console.log('query | task | recall | mrr');
for (const r of rows) console.log(`${r.q} | ${r.task} | ${r.recall} | ${r.mrr}`);
console.log(`\nqueries ${n}  recall ${((sumRecall / n) * 100).toFixed(1)}%  mrr ${(sumMRR / n).toFixed(3)}`);
