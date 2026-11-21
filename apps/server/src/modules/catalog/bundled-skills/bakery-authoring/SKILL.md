---
name: bakery-authoring
description: Write a Bakery skill an agent can follow without asking questions.
---

# Writing a Bakery skill

A skill is a short set of instructions an agent reads before it does one kind of
work. Write it so a new teammate could follow it with no one to ask.

## What to put in it

- **Purpose.** One sentence: what the work is and when to use this skill.
- **Inputs.** What the agent is given and what it must check is present.
- **Steps.** Numbered, in order, each one small enough to be done or not done.
- **Done.** How the agent knows it has finished, and what it hands back.
- **Stop and ask.** The cases where the agent must stop instead of guessing.

## How to write it

- Use plain words and short sentences. Name things the way the team does.
- Say what to do, not what to avoid. Give one example where a rule is easy to
  misread.
- Keep one skill to one job. Split a skill that has two purposes.
- Link other files in this skill by their path (for example `checklist.md`) so
  they travel with it. Do not link to places the agent cannot open.

## Before you publish

1. Run the skill's check and fix every problem it names.
2. Read it once as the agent would, from the first line, with nothing else open.
3. Publish. The version is fixed from then on; to change it, publish the next
   one.

This skill comes with Bakery and cannot be changed. Make a copy to adapt it.
