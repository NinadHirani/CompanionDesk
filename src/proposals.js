'use strict';

// "Remember this?" suggestions. After a question, the local model may propose
// up to two durable things the student said about themselves. Nothing is
// saved from here: proposals wait for the user's yes. Several guards keep a
// small model honest: it must quote the student's own words closely, it may
// not propose dates or deadlines, and it never runs in the cloud.

const { SECTIONS, sanitizeBullet, normalize } = require('./memory');
const { tokens } = require('./persona');

const FIRST_PERSON = /\b(i|i'm|i've|i'll|i'd|my|me|mine|myself|we|our)\b/i;
const DATEISH = new RegExp(
  [
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    '\\b\\d{1,2}[/.-]\\d{1,2}([/.-]\\d{2,4})?\\b',
    '\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b',
    '\\b(due|deadline|deadlines)\\b',
  ].join('|'),
  'i'
);

// Cheap gate before spending a model call: only longer messages that talk
// about the student themselves.
function shouldSuggest(message) {
  return typeof message === 'string' && message.trim().length >= 12 && FIRST_PERSON.test(message);
}

function buildProposalPrompt(message) {
  return {
    system: [
      'You pick out durable facts a student stated about themselves.',
      `Reply with JSON only: an array of at most 2 objects like {"section":"${SECTIONS.join('|')}","text":"..."}.`,
      'Only include something the student clearly said about themselves in their message, in their own words.',
      'Never include deadlines or dates. Never guess. Reply [] when there is nothing.',
    ].join(' '),
    prompt: `Student message:\n${String(message).slice(0, 1500)}`,
  };
}

function extractArray(raw) {
  const text = String(raw ?? '');
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a === -1 || b <= a) return [];
  try {
    const parsed = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// existing: strings already remembered or already waiting for a decision.
function parseProposals(raw, { message, existing = [], max = 2 } = {}) {
  const have = new Set(existing.map(normalize));
  const said = tokens(message);
  const out = [];
  for (const item of extractArray(raw)) {
    if (!item || typeof item !== 'object') continue;
    if (!SECTIONS.includes(item.section) || typeof item.text !== 'string') continue;
    const text = sanitizeBullet(item.text);
    if (!text || text.length < 8 || text.length > 160) continue;
    if (DATEISH.test(text)) continue;
    // Grounding: most of what it proposes must come from the student's message.
    const mine = tokens(text);
    let overlap = 0;
    for (const w of mine) if (said.has(w)) overlap += 1;
    if (overlap < Math.min(2, mine.size) || mine.size === 0) continue;
    const key = normalize(text);
    if (have.has(key)) continue;
    have.add(key);
    out.push({ section: item.section, text });
    if (out.length >= max) break;
  }
  return out;
}

// Local model only: ai.chat talks to Ollama and has no cloud fallback.
async function suggest({ ai, message, existing = [] }) {
  if (!shouldSuggest(message)) return [];
  const { system, prompt } = buildProposalPrompt(message);
  let raw;
  try {
    raw = await ai.chat({ system, prompt, temperature: 0 });
  } catch {
    return [];
  }
  return parseProposals(raw, { message, existing });
}

module.exports = { shouldSuggest, buildProposalPrompt, parseProposals, suggest };
