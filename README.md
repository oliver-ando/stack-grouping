# Stack Grouper PoC

A proof-of-concept application for intelligently grouping messages into semantic stacks using a multi-level approach.

## Overview

This tool processes message events and groups them through three levels:

1. **L1: Atomic Units** - Creates initial message groupings using deterministic rules (temporal proximity, threads, reply patterns)
2. **L1.5: Validated Units** - Uses AI to validate and adjust units, merging semantically related adjacent units
3. **L2: Stacks** - Groups validated units into semantic stacks based on topic similarity

## Features

- **Smart Message Grouping**: Detects replies, continuations, and semantic relationships
- **Thread Awareness**: Handles threaded conversations even when interrupted by other messages
- **Async Conversation Support**: Groups messages that are semantically related even with large time gaps (up to 24 hours)
- **AI-Powered Validation**: Uses Anthropic Claude API to refine groupings
- **Interactive UI**: Visual interface to see grouping at each level with expandable units
- **Batched Processing**: Efficient processing with overlapping batches to catch cross-boundary relationships

## Order of Operations

### Stage 0: Input Processing
- Extracts messages from raw event JSON
- Filters messages with valid `id` and `created_at`
- Sorts messages chronologically

### Level 1: Atomic Units (Deterministic)
**No API calls required** - Uses deterministic rules in priority order:

1. **Same Thread (Highest Priority)**: 
   - Messages in the same thread are **always** grouped together
   - No time limit - threads can span hours or days
   - Handles interruptions: If a thread is interrupted by other messages, subsequent thread messages are merged back into the original unit
   - Checks both the last message AND any message in the current unit
   - Checks recently completed units (last 5) to merge thread messages back

2. **Temporal Proximity**: 
   - Same author + same conversation + <2 minutes
   - Same conversation + <1 minute

3. **Continuation Signals**: Short acknowledgments (<3 minutes apart)

4. **Reply-like Messages**: Detects replies using multiple heuristics:
   - Exact reply patterns ("yeah", "yes", "exactly", etc.)
   - Messages starting with reply words ("yeah - i think...")
   - Semantic continuation (shared keywords)
   - Short elaborations

**Key Features**:
- Thread messages are grouped regardless of time gaps or interruptions
- Checks against both last message AND first message of current unit
- Handles async replies up to 24 hours apart
- Automatically merges thread messages back into previous units when interrupted

### Level 1.5: Validated Units (AI-Powered)
**Requires Anthropic API key**

**Batching Strategy**:
- Processes units in batches of 10
- Overlaps batches by 3 units to catch cross-boundary relationships
- Post-merge pass checks all adjacent unit pairs

**AI Validation**:
- Checks unit coherence (all messages same topic?)
- Identifies splits (topic changes mid-unit)
- Identifies merges (adjacent units discuss same topic)

**Actions**:
- **Keep**: Unit is coherent, no changes
- **Split**: Split unit at specified message indices
- **Merge**: Merge multiple adjacent units

### Level 2: Stacks (Semantic Topic Grouping)
**Requires Anthropic API key**

- Processes units sequentially
- For each unit, AI determines:
  - Join existing stack (if semantically similar)
  - Create new stack (if new topic)
- Focuses on semantic similarity, not temporal proximity
- Can group units that are hours or days apart if they discuss the same topic

## Detailed Documentation

For comprehensive documentation on:
- All deterministic rules and patterns
- Complete AI prompts
- Processing algorithms
- Error handling
- Performance considerations

See [ARCHITECTURE.md](./ARCHITECTURE.md)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open the app in your browser (typically `http://localhost:5173`)

## Usage

1. Paste your events JSON into the input field
2. Enter your Anthropic API key
3. Process through each level:
   - **L1**: Creates atomic units automatically
   - **L1.5**: Validates and merges units (requires API key)
   - **L2**: Forms semantic stacks (requires API key)

## Project Structure

- `stack-grouper-poc-v3.jsx` - Main React component with all grouping logic
- `src/main.jsx` - React entry point
- `src/index.css` - Tailwind CSS styles
- `ARCHITECTURE.md` - Comprehensive architecture documentation
- `event-list-item-for-llm-grouping.json` - Sample data for evaluation

## Technologies

- **React** - UI framework
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Styling
- **Anthropic Claude API** - AI-powered validation and grouping (claude-sonnet-4-20250514)

## API Requirements

- **Anthropic API Key**: Required for L1.5 and L2 processing
- **Model**: `claude-sonnet-4-20250514`
- **Rate Limiting**: Built-in delays between API calls (50-200ms)

## Key Design Decisions

1. **L1 is Deterministic**: Fast, no API calls, handles obvious groupings
2. **L1.5 Validates Adjacent Units**: Focuses on semantic coherence within batches
3. **L2 Groups by Topic**: Handles broader semantic relationships across entire dataset
4. **Thread Handling**: Special logic to maintain thread continuity even when interrupted
5. **Async Support**: 24-hour window for reply detection handles async conversations
6. **Semantic Continuation**: Keyword matching catches related messages even without explicit reply signals

