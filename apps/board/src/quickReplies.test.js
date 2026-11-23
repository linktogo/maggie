import { test, expect } from 'vitest';
import { asksQuestion, quickReplies } from './quickReplies.js';

const words = { yes: 'Yes', no: 'No' };
const agent = (content) => ({ id: 1, role: 'agent', kind: 'text', content });

const STORAGE = [
  'Before I add persistence, how should orders be stored?',
  '',
  '1. **In memory** — quickest, lost on restart',
  '2. **PostgreSQL with TypeORM** — matches the rest of the app',
  '3. **Prisma** — new dependency',
  '',
  'Which one do you want?',
].join('\n');

test('an ordered list in a question becomes numbered choices, from the bold label', () => {
  expect(quickReplies([agent(STORAGE)], words)).toEqual([
    { label: 'In memory', text: '1. In memory' },
    { label: 'PostgreSQL with TypeORM', text: '2. PostgreSQL with TypeORM' },
    { label: 'Prisma', text: '3. Prisma' },
  ]);
});

test('a bullet list takes the text before a separator, and sends the label alone', () => {
  const text = 'Two ways:\n\n- Keep it - simple\n* Rewrite: from scratch\n+ `Patch` it\n\nWhich?';
  expect(quickReplies([agent(text)], words)).toEqual([
    { label: 'Keep it', text: 'Keep it' },
    { label: 'Rewrite', text: 'Rewrite' },
    { label: 'Patch it', text: 'Patch it' },
  ]);
});

test('only the last list counts, and a list split by blank lines stays one list', () => {
  const text = 'Done:\n\n- a\n- b\n\nNext, pick one:\n\n1. __Fast__ – cheap\n\n2. Slow\n\nOk?';
  expect(quickReplies([agent(text)], words).map((c) => c.text)).toEqual(['1. Fast', '2. Slow']);
});

test('at most 6 choices, each label at most 60 characters', () => {
  const items = Array.from({ length: 8 }, (_, i) => `${i + 1}. ${'x'.repeat(80)}${i}`).join('\n');
  const choices = quickReplies([agent(`Pick:\n${items}\nWhich?`)], words);
  expect(choices).toHaveLength(6);
  expect(choices[0].label).toHaveLength(60);
});

test('a closed question without a list gets yes and no, in English or French', () => {
  expect(quickReplies([agent('I added the module. Should I also add the migration?')], words)).toEqual([
    { label: 'Yes', text: 'Yes' }, { label: 'No', text: 'No' },
  ]);
  expect(quickReplies([agent('Faut-il ajouter la migration ?')], { yes: 'Oui', no: 'Non' }).map((c) => c.text)).toEqual(['Oui', 'Non']);
  expect(quickReplies([agent('Est-ce que je continue ?')], words)).toHaveLength(2);
});

test('an open question without a list gets nothing', () => {
  expect(quickReplies([agent('What should the module be called?')], words)).toEqual([]);
});

test('nothing unless the last message is an agent text that asks a question', () => {
  expect(quickReplies([], words)).toEqual([]);
  expect(quickReplies([agent(STORAGE), { id: 2, role: 'user', kind: 'text', content: '2' }], words)).toEqual([]);
  expect(quickReplies([{ id: 3, role: 'agent', kind: 'step', content: { tool: 'Read', summary: 'x' } }], words)).toEqual([]);
  expect(quickReplies([agent('Summary:\n\n1. one\n2. two\n\nAll done.')], words)).toEqual([]);
});

test('asksQuestion: a turn ending on a question, markdown closers allowed', () => {
  expect(asksQuestion('Ok?**')).toBe(true);
  expect(asksQuestion('Ok.')).toBe(false);
  expect(asksQuestion(null)).toBe(false);
});
