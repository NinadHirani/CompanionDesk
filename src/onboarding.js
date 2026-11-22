'use strict';

// First-run interview. Fixed questions, so it works with no model at all.
// Every answer is optional. What the student says becomes a plain bullet in
// their me.md or a setting; nothing is inferred.

const { cleanLine } = require('./settings');
const { sanitizeBullet } = require('./memory');

const BEST_TIME = {
  Mornings: 'I work best in the morning',
  Afternoons: 'I work best in the afternoon',
  Evenings: 'I work best in the evening',
  'Late at night': 'I work best late at night',
  'It varies': 'The time of day I work best varies',
};

const STYLE = {
  'Short and direct': { tone: 'direct', brevity: 'short' },
  'Warm and encouraging': { tone: 'warm', brevity: 'normal' },
  'Detailed and formal': { tone: 'formal', brevity: 'detailed' },
};

const QUESTIONS = Object.freeze([
  { id: 'name', kind: 'text', prompt: 'What should I call you?' },
  { id: 'goal', kind: 'text', prompt: 'What are you working toward right now? A grade, a project, an application, anything.' },
  { id: 'hours', kind: 'number', min: 1, max: 80, prompt: 'Roughly how many hours a week can you really give to focused work?' },
  { id: 'best', kind: 'choice', options: Object.keys(BEST_TIME), prompt: 'When do you work best?' },
  { id: 'outside', kind: 'text', prompt: 'Anything with a deadline outside class? Applications, hackathons, exams you registered for. Name them now; you can add the dates later.' },
  { id: 'style', kind: 'choice', options: Object.keys(STYLE), prompt: 'How should I talk to you?' },
]);

// -> { ok: true, skipped: true }
//  | { ok: true, memory: { section, text } }
//  | { ok: true, settings: { ... } }
//  | { ok: false, error }
function interpretAnswer(id, answer) {
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) return { ok: false, error: 'unknown_question' };
  if (answer === null || answer === undefined || (typeof answer === 'string' && !answer.trim())) return { ok: true, skipped: true };

  if (q.kind === 'number') {
    const n = typeof answer === 'number' ? answer : Number(String(answer).trim());
    if (!Number.isInteger(n) || n < q.min || n > q.max) return { ok: false, error: 'invalid_answer' };
    return { ok: true, memory: { section: 'Routines', text: `I can realistically give about ${n} hours a week to focused work` } };
  }
  if (typeof answer !== 'string') return { ok: false, error: 'invalid_answer' };

  if (q.kind === 'choice') {
    if (!q.options.includes(answer)) return { ok: false, error: 'invalid_answer' };
    if (id === 'best') return { ok: true, memory: { section: 'Routines', text: BEST_TIME[answer] } };
    return { ok: true, settings: { ...STYLE[answer] } };
  }

  if (id === 'name') {
    const name = cleanLine(answer, 40);
    return name ? { ok: true, settings: { user_name: name } } : { ok: true, skipped: true };
  }
  const text = sanitizeBullet(answer);
  if (!text) return { ok: true, skipped: true };
  if (id === 'goal') return { ok: true, memory: { section: 'Goals', text: `Working toward: ${text}` } };
  return { ok: true, memory: { section: 'Facts', text: `Outside class I am handling: ${text}` } };
}

module.exports = { QUESTIONS, interpretAnswer };
