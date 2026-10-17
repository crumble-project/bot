# Crumble

Crumble gives each bot an identity, ongoing responsibilities, and a continuous chat with its owner.

## Language

**Bot**:
An independently configured assistant with its own identity, memory, capabilities, and responsibilities.
_Avoid_: Persona, session

**Bot chat**:
The continuous direct-message exchange between a bot and its owner, including work the bot performs in the background.
_Avoid_: Conversation session, new chat

**Transcript**:
The complete visible history of a bot chat, including messages, replies, tool activity, and compaction events.
_Avoid_: Model context

**Working context**:
The selected recent messages, summaries, instructions, and recalled material available to the bot for its next response.
_Avoid_: Full history, transcript

**Compaction**:
Summarizing older working context while keeping the original transcript available to the owner.
_Avoid_: Deleting history, starting a new chat

**Reply**:
A new message linked to an earlier transcript message, recalling that message and bounded surrounding context for the bot.
_Avoid_: Fork, branch, session
