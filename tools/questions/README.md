# Weekly question packs

Each week a new pack of questions is written, checked against everything already in the game, and added to
`index.html` as a `/* question pack N */` block. The audience is UK pub-quiz players, phones in hand, playing with friends.

## Steps (run from the repo root)

1. `python3 tools/questions/dump_bank.py` writes `tools/questions/existing.json` (every current question).
2. Write a candidate pack as JSON (format in `check_pack.py`). Read `existing.json` first to see what's covered.
3. `python3 tools/questions/check_pack.py candidate.json filtered.json` drops duplicates, rewordings and malformed items.
4. `python3 tools/questions/inject_pack.py filtered.json "short description"` adds it to the game.
5. Load the game once and check the console has no errors.
6. Commit on a branch named `questions-YYYY-MM-DD`. Don't merge to `main` (that deploys) until the owner says "push".

## What a good pack looks like (about 300–400 kept items)

- Roughly: 80 `gk_hard`, 80 `gk`, 40 `gk_pop`, 25 `est`, 15 `est_hard`, 20 pins across `pin`/`pin_pop`/`pin_hard`,
  10 `rank`, 5 `uniq`, 5 `mf`, 40 Higher or Lower items, and 3–4 Speed Round questions for each of 10 or so topics.
- The hard and medium pools matter most: medium games take a third of their questions from `*_hard`.
- Fresh angles beat obvious facts: the bank already has the famous capitals, flags, firsts and "who sang X" staples,
  so about half of anything obvious gets dropped as a duplicate.
- Every fact must be certain. Leave out anything contested, changing (current champions, records likely to fall,
  "most" claims that a single new result could change), or dependent on a definition (city vs metro population).
- Wrong options must be plausible but clearly wrong. One right answer only.
- Not too easy, not too hard: a decent pub quiz team should get about 60–70% of `gk`, 40–50% of `gk_hard`.
- UK spelling and a UK slant (football, TV, places), but plenty of world knowledge too.
- Topics to rotate through: music by decade, film, TV, sport, history, geography, science, nature, food and drink,
  literature, art, language, technology, games, the UK.
