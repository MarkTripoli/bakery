Ticket: [#number](https://github.com/OWNER/REPOSITORY/issues/number) | Task: [task-id](https://github.com/OWNER/REPOSITORY/issues/number) | Walkthrough: not requested

<!-- Write for an executive: plain words, short sentences, no filler. The
description check fails a body over 300 words of prose (code, tables, links
and comments don't count). If a point doesn't change what a reader decides,
cut it. -->

## Purpose

<!-- One sentence, at most 40 words: what this lets someone do that they couldn't before. -->

## Risk

<!-- First line: Level: Low, Medium or High. Then one to three bullets, at
most 25 words each: what could break, who it affects, and how to roll back. -->

Level: Low

-

## Special things to note

<!-- One to four bullets, at most 25 words each: scope cuts, migrations,
compatibility, anything unverified. Use - None. when there is nothing. -->

## Change outline

<!-- The heart of the PR: let a reader understand the change without reading the
code. Use one to three views (show-me style), up to 80 lines in total, plus at most
40 words of prose. Pick what fits: a Mermaid flowchart or sequence diagram, a
call tree, a diff of the API or contract, a shallow file tree, or pseudocode.
Name the design pattern when there is one ("Pattern: outbox"). Use real names.
For a truly structure-free change, write "No structural change: <reason>". -->

## Decisions

<!-- Up to three bullets, at most 30 words each: "Chose X over Y because Z."
Use - None. when no real choice was made. -->

## Evidence

<!-- Only what a reader can't get from CI: UI screenshots or a recording
(at most four images; link a folder for more), and the new tests, with one line
each on what they prove. No format, lint or type checks. Use - None. when there
is nothing to show. -->

- None.

## Verification

<!-- Ticked by the verifier named in brackets during review, not by the author.
Each box is ticked, or replaced with "N/A: <reason>". The description check
stays red until every box is resolved, so it doubles as the merge gate. -->

- [ ] Backend verified (reviewer): contracts, data, permissions and errors behave as described.
- [ ] UI verified (design-ux): no duplicate of an existing screen or component; fits the navigation; consistent patterns; desktop and phone, light and dark.
- [ ] Implementation clean (reviewer): follows existing patterns, no duplicated logic, no dead code, nothing outside the ticket.
- [ ] Tests cover the change (qa): new behavior has tests that fail without it.
