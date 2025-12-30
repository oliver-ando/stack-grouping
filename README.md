# Stack Grouper PoC

A proof-of-concept application for intelligently grouping messages into semantic stacks using a multi-level approach.

## Overview

This tool processes message events and groups them through three levels:

1. **L1: Atomic Units** - Creates initial message groupings based on temporal proximity, threads, and reply patterns
2. **L1.5: Validated Units** - Uses AI to validate and adjust units, merging semantically related adjacent units
3. **L2: Stacks** - Groups validated units into semantic stacks based on topic similarity

## Features

- **Smart Message Grouping**: Detects replies, continuations, and semantic relationships
- **Thread Awareness**: Handles threaded conversations even when interrupted by other messages
- **Async Conversation Support**: Groups messages that are semantically related even with large time gaps
- **AI-Powered Validation**: Uses Anthropic Claude API to refine groupings
- **Interactive UI**: Visual interface to see grouping at each level

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

- `stack-grouper-poc-v3.jsx` - Main React component with all logic
- `src/main.jsx` - React entry point
- `src/index.css` - Tailwind CSS styles
- `event-list-item-for-llm-grouping.json` - Sample data for evaluation

## Technologies

- React
- Vite
- Tailwind CSS
- Anthropic Claude API

