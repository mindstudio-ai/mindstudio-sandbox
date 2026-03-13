---
name: Haiku Generator
description: Generate haikus about any topic using AI.
version: 1
tooling:
  runtime: node
  language: typescript
  sdk: "@mindstudio-ai/agent"
  formatting: prettier
  file structure: src/tables/ for data model, src/*.ts for methods, src/common/ for helpers
  conventions: one method per file, exported named Input/Output interfaces, single input param
---

# Haiku Generator

A simple app that generates haikus about any topic using AI and keeps a
history of everything generated.

## Data Model

One table: haikus. Each row stores the topic the user asked about and the
AI-generated haiku text.

~~~
No user field — haikus are shared across all users of the app. This keeps
the starter app simple. A real app might add a `createdBy: User` field to
scope haikus per user.
~~~

## Generate Haiku

The user provides a topic (any freeform text). The app calls AI to write
a haiku about that topic, saves it to the table, and returns the result.

~~~
The AI prompt should ask for exactly a haiku — three lines, no title, no
extra commentary. The response is stored as-is. If the AI returns
something other than a clean haiku, that's fine — we don't validate the
syllable count.
~~~

## List Haikus

Returns all haikus, newest first. No pagination — this is a starter app,
not a production system.

## Delete Haiku

Deletes a haiku by ID. No confirmation, no soft delete.
