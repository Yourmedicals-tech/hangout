# Hangout

Somebody near you is one player short. Find them.

A prototype for connecting people who want to play the same thing, nearby. Cricket and
badminton, within 10 miles of Wigston, Leicester — deliberately narrow while we prove the
loop works.

## The idea

The problem isn't a shortage of pitches or leisure centres. It's that when you move
somewhere new, or you just don't happen to know the right people, there is **nobody to
ask**. Hangout is the shortest path between "I want to play" and "I'm playing on Friday".

The core loop:

1. Someone is short a player for a real game at a real venue.
2. Everyone nearby who plays that thing gets told.
3. One of them taps **I'm in**.
4. The court gets booked and the cost gets split.

Everything else — book clubs, how-to videos, a wallet, formal communities — is queued
behind that loop working at all.

## What's here

| File | What it is |
|---|---|
| `index.html` | The walkthrough prototype. Sign up, onboard, browse, join, post, chat, book, split the cost. |
| `design-board.html` | The design board — every screen laid out at once, with the reasoning for each. |

Both are single self-contained HTML files. No build step, no dependencies, no server.
Open them in a browser, or serve the folder with anything.

## Prototype, not product

State lives in `localStorage`, so the app remembers you between visits but nothing leaves
your phone. Sign-up accepts anything — there's no backend. The other players are fixtures
and their replies are canned. "38 people nearby" is a constant, not a query.

Everything you *tap* is real. Everything on the other end of the wire is theatre.

There's a **Reset the prototype** button at the bottom of the *You* tab.
