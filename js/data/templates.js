// Reusable commissioner message templates. Tokens in [BRACKETS] are filled
// automatically where the app knows them; the rest are highlighted as unfilled.

export const AUTO_TOKENS = ['[LEAGUE NAME]', '[WEEK]', '[YEAR]', '[COMMISH NAME]'];

export const MESSAGE_TEMPLATES = [
  {
    id: 'welcome',
    name: 'Season Welcome',
    body: `Welcome to [LEAGUE NAME] for the [YEAR] season! 🏈

Draft and roster moves are live in Sleeper. Dues are [AMOUNT] — please send to [PAYMENT INFO] by [DATE].

Let's have a great year.
— [COMMISH NAME]`,
  },
  {
    id: 'dues',
    name: 'Dues Reminder',
    body: `Reminder for [LEAGUE NAME]: [YEAR] dues of [AMOUNT] are due by [DATE].

Still outstanding: [UNPAID MANAGERS]

Send to [PAYMENT INFO]. Thanks!
— [COMMISH NAME]`,
  },
  {
    id: 'waiver',
    name: 'Waiver Alert',
    body: `[LEAGUE NAME] — Week [WEEK] waivers process [DATE].

Some notable names are still available on the wire. Get your claims in before the deadline.
— [COMMISH NAME]`,
  },
  {
    id: 'deadline',
    name: 'Trade Deadline',
    body: `⏰ Trade deadline for [LEAGUE NAME] is [DATE] (Week [WEEK]).

Get your deals done before then — no trades process after the deadline.
— [COMMISH NAME]`,
  },
  {
    id: 'playoff',
    name: 'Playoff Race',
    body: `[LEAGUE NAME] — Week [WEEK] playoff picture 🏆

[STANDINGS]

Every game counts down the stretch. Good luck!
— [COMMISH NAME]`,
  },
  {
    id: 'hype',
    name: 'Weekly Hype',
    body: `Week [WEEK] of [LEAGUE NAME] is here! 🔥

Lineups lock at kickoff — set yours and check your matchup. Talk your trash in the chat.
— [COMMISH NAME]`,
  },
  {
    id: 'rule',
    name: 'Rule Change',
    body: `[LEAGUE NAME] rule update for [YEAR]:

[RULE DETAILS]

Reply with questions or concerns before this takes effect on [DATE].
— [COMMISH NAME]`,
  },
  {
    id: 'general',
    name: 'General Update',
    body: `[LEAGUE NAME] update:

[MESSAGE]

— [COMMISH NAME]`,
  },
];
