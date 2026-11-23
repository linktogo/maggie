# Factory chat: medium-width layout and quick replies — design

Small change. Mockup: `.superpowers/brainstorm/factory-chat-v1.html` (local, not committed).

## Intent

1. **Fix the squeezed chat.** Between ~800 and ~1100 px wide, the Projects (15rem) and
   Requests (20rem) columns keep their width and the conversation gets what is left —
   ~190 px at 820 px: model and branch badges are cut off, text wraps every three words.
   The conversation is what the user reads; it must get the room.
2. **Quick replies.** When the agent ends its turn on a choice question, answering should
   be one click instead of typing "2".

## Approaches

- Layout: *(chosen)* below `xl` (1280 px), the Projects column folds into a project
  selector at the top of the Requests column — two columns instead of three. Rejected:
  shrinking the fixed widths (still squeezed at 820 px); a collapsible rail (more UI for the
  same result).
- Quick replies placement: *(user's pick: B)* suggestion chips just above the composer.
  Rejected: buttons inside the question bubble (A).
- Click behaviour: *(user's pick)* a click sends the answer at once.

## Behaviour

**Layout**
- `md`–`xl`: grid `[20rem | 1fr]`; the Requests pane starts with a `<select>` of projects
  (same list and counts as the Projects pane, same navigation). `xl` and up: unchanged three
  columns. Below `md`: unchanged single pane with Back.
- Conversation header: badges wrap instead of overflowing; the worktree branch truncates
  with an ellipsis (full name in its tooltip, as today).

**Quick replies** — shown above the composer when all hold: the thread is idle and
resumable, and the last message is an agent text that asks a question (the existing
`asksQuestion` rule).
- *Choices:* the items of the last list (ordered or not) in that message, at most 6.
  Label: the leading bold text if any, else the text before ` — `, ` – `, ` - ` or `:`,
  trimmed to 60 characters. Ordered items keep their number. Sent text: `2. PostgreSQL with
  TypeORM` (number when ordered, then the label).
- *Yes/no:* no list, and the question sentence starts with an auxiliary (EN: should, shall,
  do, does, can, could, would, will, is, are, may; FR: dois-je, faut-il, veux-tu,
  voulez-vous, souhaites-tu, souhaitez-vous, est-ce). Buttons Yes / No in the board's
  language; the sent text is that word.
- A last chip, *Other…*, focuses the reply box.
- A click sends through the same path as the composer (`factory.reply`); chips are
  disabled while sending and disappear once the agent runs again.
- Nothing is shown when no choice is recognised: the composer works as today.

## Non-goals

- No change to the agents server or to what the agent is told; detection is on the board.
- No buttons on older questions in the transcript, only the last one.

## Left to the builder

Component split (a small `FactoryQuickReplies.vue` plus a pure `quickReplies.js` parser),
translations (en/fr/de/es), tests at the 100% gate.
