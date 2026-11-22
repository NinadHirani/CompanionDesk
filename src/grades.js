'use strict';

// Grade standing and "what do I need" maths for one course. Pure: no fs, no
// database, no network, no model.
//
// The rule from CLAUDE.md applies: never guess. Weights come only from the
// syllabus. If they do not add up to 100 the course cannot be projected, and
// the result says why instead of filling a gap.
//
// Assumption, stated in the result: items in the same grading category count
// equally, so a category worth 20% with 4 listed items gives each item 5%.

const norm = (s) => String(s ?? '').trim().toLowerCase();
const round2 = (n) => Math.round(n * 100) / 100;

// weights:     [{ category, weight_pct }]
// assignments: [{ id, title, category }]  (every item listed for the course)
// scores:      { [assignmentId]: percent 0..100 }
function courseStanding({ weights, assignments, scores }) {
  const totalWeight = round2(weights.reduce((sum, w) => sum + w.weight_pct, 0));
  const weightsComplete = Math.abs(totalWeight - 100) <= 0.5;

  const countByCategory = new Map();
  for (const w of weights) countByCategory.set(norm(w.category), 0);
  const unweighted = [];
  for (const a of assignments) {
    const key = norm(a.category);
    if (countByCategory.has(key)) countByCategory.set(key, countByCategory.get(key) + 1);
    else if (scores[a.id] !== undefined) unweighted.push(a.title);
  }

  let gradedWeight = 0;
  let earnedPoints = 0; // points of the final grade already earned
  for (const a of assignments) {
    const key = norm(a.category);
    const score = scores[a.id];
    if (score === undefined || !countByCategory.has(key)) continue;
    const w = weights.find((x) => norm(x.category) === key);
    const share = w.weight_pct / countByCategory.get(key);
    gradedWeight += share;
    earnedPoints += (score * share) / 100;
  }
  gradedWeight = round2(gradedWeight);
  earnedPoints = round2(earnedPoints);

  return {
    weightsComplete,
    totalWeight,
    gradedWeight,
    remainingWeight: round2(Math.max(0, totalWeight - gradedWeight)),
    earnedPoints,
    // Average on the work graded so far; null until something is graded.
    currentPct: gradedWeight > 0 ? round2((earnedPoints / gradedWeight) * 100) : null,
    unweighted,
    assumption: 'Items in the same category are counted equally.',
  };
}

// What average the remaining work must reach for the course to end at targetPct.
// -> { status: 'needed', needed, reachable }
//  | { status: 'secured' }          the target is already guaranteed
//  | { status: 'nothing_left' }     everything is graded
//  | { status: 'cannot_project', reason }
function neededForTarget(standing, targetPct) {
  if (!Number.isFinite(targetPct) || targetPct < 0 || targetPct > 100) return { status: 'cannot_project', reason: 'invalid_target' };
  if (!standing.weightsComplete) return { status: 'cannot_project', reason: 'weights_incomplete' };
  if (standing.remainingWeight <= 0) return { status: 'nothing_left' };
  const pointsNeeded = targetPct - standing.earnedPoints;
  if (pointsNeeded <= 0) return { status: 'secured' };
  const needed = round2((pointsNeeded / standing.remainingWeight) * 100);
  return { status: 'needed', needed, reachable: needed <= 100 };
}

module.exports = { courseStanding, neededForTarget };
