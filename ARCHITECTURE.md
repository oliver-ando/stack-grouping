# Architecture & Order of Operations

This document provides a comprehensive overview of how the Stack Grouper processes messages through multiple levels of grouping.

## Overview

The system processes messages through three main stages:
1. **L1: Atomic Units** - Deterministic initial grouping
2. **L1.5: Validated Units** - AI-powered validation and adjustment
3. **L2: Stacks** - Semantic topic-based grouping

---

## Stage 0: Input Processing

### Message Extraction

Raw event data is transformed into a standardized message format:

```javascript
{
  id: string,
  created_at: ISO timestamp,
  content: string (markdown_content),
  author: string (display_name),
  conversation_id: string,
  conversation_name: string,
  thread_id: string | null (thread_root_id)
}
```

**Filtering**: Only messages with both `id` and `created_at` are included.

**Sorting**: Messages are sorted chronologically by `created_at`.

---

## Level 1: Atomic Units (Deterministic)

**Purpose**: Create initial message groupings using deterministic rules based on temporal proximity, threads, and reply patterns.

**Processing**: Sequential, message-by-message

### Deterministic Rules (in priority order)

#### Priority 1: Same Thread (Highest Priority)
- **Rule**: If `msg.thread_id === prev.thread_id` AND both are non-null
- **Action**: Always extend current unit (no time limit)
- **Also checks**: If `msg.thread_id` matches ANY message in current unit (handles interruptions within unit)

**Thread Interruption Handling**: 
When a message doesn't extend the current unit, the system checks:
1. **Current unit check**: If the message's thread_id matches any message in the current unit → extend instead of closing
2. **Previous units check**: If the message's thread_id matches any message in recently completed units (last 5 units) → merge into that unit instead of creating a new one

This ensures that all messages in the same thread are grouped together, even if:
- Messages from different conversations interrupt the thread
- There are large time gaps between thread messages
- The thread spans multiple initial units

**Example**: 
- Unit 1: Thread messages A, B
- Interruption: Non-thread message C (different conversation)
- Thread message D arrives → Merged back into Unit 1 (not Unit 2)

#### Priority 2: Temporal Proximity
- **Rule 2a**: Same author + same conversation + time difference < 2 minutes
- **Rule 2b**: Same conversation + time difference < 1 minute
- **Action**: Extend current unit

#### Priority 3: Continuation Signals
- **Rule**: Message matches continuation pattern + same conversation + time difference < 3 minutes
- **Continuation patterns**:
  - Single-word acknowledgments: `yeah`, `yea`, `ya`, `yep`, `yes`, `no`, `nope`, `ok`, `okay`, `k`, `kk`, `sure`, `agreed`, `exactly`, `right`, `true`, `lol`, `haha`, `hmm`, `ah`, `oh`, `nice`, `cool`, `great`, `thanks`, `ty`, `thx`, `+1`, `^`, `this`, `same`, `def`, `definitely`, `totally`, `yup`, `nah`, `word`, `bet`, `facts`, `fr`, `real`, `tru`, `omg`, `wow`, `ooh`, `ahh`
  - Very short messages: 1-10 characters total

#### Priority 4: Reply-like Messages (Async Support)
- **Rule**: Same conversation + message is reply-like + time difference < 24 hours
- **Checks against**: Both the last message AND the first message of current unit (for longer conversations)

**Reply Detection** (`isReplyLikeMessage`):

1. **Short Reply Patterns**:
   - Exact match: `yeah`, `yea`, `ya`, `yep`, `yes`, `exactly`, `right`, `agreed`, `sure`, `definitely`, `totally`, `same`, `this`, `that`, `true`
   - Negative: `no`, `nope`, `nah`, `not really`, `disagree`
   - Acknowledgment: `ok`, `okay`, `k`, `kk`, `got it`, `makes sense`, `understood`
   - Gratitude: `thanks`, `thank you`, `ty`, `thx`, `appreciate it`
   - Positive: `cool`, `nice`, `great`, `awesome`, `love it`
   - OR: Messages ≤20 chars starting with reply words

2. **Starts with Reply**:
   - Pattern: `/^(yeah|yea|ya|yep|yes|no|nope|ok|okay|right|exactly|sure|agreed|definitely|totally|yup|nah)\s*[-,:;]?\s*/i`
   - Catches: "yeah - i think...", "yes, that makes sense...", etc.

3. **References Previous**:
   - Contains: "this", "that", "same"
   - OR: Very short relative to previous (< 30% of previous message length)

4. **Semantic Continuation**:
   - Message ≤50 chars
   - Shares keywords (3+ char words) with previous message
   - At least one shared word is 4+ characters
   - Example: "involuntary nap" shares "nap" with "good! a nap at this hour..."

5. **Short Elaboration**:
   - Previous message >20 chars (substantial)
   - Current message ≤30 chars
   - Current < 50% of previous length

### Unit Creation

When a unit is finalized, it creates:
```javascript
{
  id: UUID,
  index: number,
  messages: Message[],
  authors: string[],
  conversation_id: string,
  conversation_name: string,
  start_time: ISO timestamp,
  end_time: ISO timestamp,
  content: string (all messages joined)
}
```

---

## Level 1.5: Validated Units (AI-Powered)

**Purpose**: Validate and adjust atomic units using AI, focusing on semantic coherence and merging adjacent units that discuss the same topic.

**Processing**: Batched with overlap + post-merge pass

### Batching Strategy

- **Batch Size**: 10 units per batch
- **Overlap**: 3 units between batches (e.g., batch 1: U1-U10, batch 2: U8-U18)
- **Rationale**: Ensures adjacent units near batch boundaries can be considered together

### Validation Prompt

**System Prompt**:
```
You validate and adjust message groupings into atomic units.
You are processing units {batchStart+1}-{batchStart+units.length} which are adjacent in the conversation timeline.

IMPORTANT: If adjacent units (e.g., U32, U33, U34) discuss the same topic or theme, they should be MERGED into a single unit.
Focus on semantic similarity - units discussing the same concept, question, or topic should be merged even if there are time gaps between them.

For each unit:
1. Check coherence: Are all messages in this unit about the same topic?
2. Check splitting: Does the topic change mid-unit? (split if needed)
3. Check merging: Does this unit discuss the same topic as adjacent units in this batch? (merge if yes)

Reply with ONLY valid JSON. No markdown, no extra text.
```

**User Prompt**:
```
Validate these {units.length} adjacent message units (units {batchStart+1}-{batchStart+units.length}):

{unitDescriptions}

For each unit, determine:
1. Is it coherent? (all messages same topic)
2. Should it split? (topic changes mid-unit)
3. Should it merge with adjacent units? (same topic/theme - MERGE if semantically related)

PRIORITY: If units are adjacent and discuss the same topic (e.g., continuing a conversation about the same subject), merge them.

Reply with ONLY this JSON:
{
  "analysis": [
    {"unit": {batchStart+1}, "action": "keep", "reason": "..."},
    {"unit": {batchStart+2}, "action": "split", "split_after_message": [2], "reason": "..."},
    {"unit": {batchStart+3}, "action": "merge", "merge_with_units": [{batchStart+4}], "reason": "..."}
  ]
}

Actions: "keep", "split", or "merge"
- split: set split_after_message to array of message indices (1-based) where to split
- merge: set merge_with_units to array of unit numbers to merge with (can merge multiple adjacent units)
```

**Unit Description Format**:
```
UNIT {unitNum} [{conversation_name}] ({timeRange}):
  [{unitNum}.1] {author}: "{content}"
  [{unitNum}.2] {author}: "{content}"
  ...
```

### Actions

1. **Keep**: Unit is coherent, no changes needed
2. **Split**: Topic changes mid-unit - split at specified message indices
3. **Merge**: Unit discusses same topic as adjacent units - merge them

### Batch Processing

1. Process batches with overlap
2. Apply adjustments from AI analysis
3. Deduplicate merged units from overlapping regions
4. Reindex all units sequentially

### Post-Merge Pass

After all batches are processed, check all adjacent unit pairs for cross-batch merges:

**System Prompt**:
```
You check if adjacent units should be merged.
If two adjacent units discuss the same topic/theme, they should be merged.
Focus on semantic similarity, not just temporal proximity.

Reply with ONLY valid JSON. No markdown, no extra text.
```

**User Prompt**:
```
Check these {pairs.length} adjacent unit pairs:

PAIR {unit1+1}-{unit2+1}:
UNIT {unit1+1}: {author}: "{content}" | {author}: "{content}" | ...
UNIT {unit2+1}: {author}: "{content}" | {author}: "{content}" | ...

For each pair, determine if they should be merged (same topic/theme).

Reply ONLY:
{
  "pairs": [
    {"unit1": {unit1+1}, "unit2": {unit2+1}, "should_merge": true/false, "reason": "..."},
    ...
  ]
}
```

**Processing**: Batches of 20 adjacent pairs, then merges chains of adjacent units.

---

## Level 2: Stacks (Semantic Topic Grouping)

**Purpose**: Group validated units into semantic stacks based on topic similarity, even if units are far apart in time.

**Processing**: Sequential, unit-by-unit

### Stack Assignment Prompt

**System Prompt**:
```
You assign message units to stacks based on semantic topic similarity.
IMPORTANT: Units can be semantically related even if they are far apart in time. 
Focus on whether they discuss the same topic, concept, or theme - not just temporal proximity.
If a unit discusses the same topic as an existing stack, join it even if the messages are hours or days apart.

Reply with ONLY valid JSON. No markdown, no extra text.
```

**User Prompt**:
```
NEW UNIT [{conversation_name}]:
  {author}: "{content}"
  {author}: "{content}"
  ...

EXISTING STACKS:
{stacksDescription}

Does this unit discuss the same topic as any existing stack? 
- If YES: join the most semantically similar stack (even if messages are far apart in time)
- If NO: create a new stack

Reply ONLY:
{"action": "join" or "create", "stack_index": <number if join>, "title": "<50 chars>", "summary": "<150 chars>"}
```

**Stack Description Format**:
```
STACK {index+1}: "{title}"
  {summary}
  Messages ({count} total):
    {author}: "{content}"
    {author}: "{content}"
    ...
    ... ({moreCount} more messages)  [if >10 messages]
```

**Message Selection**: 
- If stack has ≤10 messages: show all
- If stack has >10 messages: show first 5 + last 2

### Stack Structure

```javascript
{
  id: UUID,
  title: string (≤50 chars),
  summary: string (≤150 chars),
  messages: Message[] (sorted chronologically)
}
```

### Processing Flow

1. For each validated unit:
   - Build prompt with unit + existing stacks
   - Call AI to determine: join existing stack or create new
   - If join: add unit's messages to existing stack, update title/summary
   - If create: create new stack with unit's messages
   - Log decision for debugging

2. Stacks accumulate messages chronologically as units are processed

---

## API Configuration

**Model**: `claude-sonnet-4-20250514`
**Endpoint**: `https://api.anthropic.com/v1/messages`
**Max Tokens**:
- L1.5 Validation: 2000
- L1.5 Post-Merge: 1000
- L2 Stack Assignment: 300

---

## Error Handling

- **JSON Parse Errors**: Attempts to fix common issues (trailing commas, unquoted keys)
- **API Failures**: 
  - L1.5: Skips batch, keeps original units
  - L1.5 Post-Merge: Continues, logs warning
  - L2: Defaults to creating new stack with error message

---

## Performance Considerations

- **Batching**: Reduces API calls and improves parallel processing
- **Overlap**: Ensures boundary cases are handled
- **Post-Merge**: Catches cross-batch relationships
- **Delays**: Small delays (50-200ms) between API calls to avoid rate limits

---

## Key Design Decisions

1. **L1 is Deterministic**: Fast, no API calls, handles obvious groupings
2. **L1.5 Validates Adjacent Units**: Focuses on semantic coherence within batches
3. **L2 Groups by Topic**: Handles broader semantic relationships across entire dataset
4. **Thread Handling**: Special logic to maintain thread continuity even when interrupted
5. **Async Support**: 24-hour window for reply detection handles async conversations
6. **Semantic Continuation**: Keyword matching catches related messages even without explicit reply signals

