import React, { useState, useMemo, useRef } from "react";

// ============================================
// UTILITIES
// ============================================

const generateUUID = () => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const formatTime = (isoString) => {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const formatShortTime = (isoString) => {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

/**
 * Format time gap between two timestamps as human-readable string
 * @param {string} laterTime - ISO timestamp
 * @param {string} earlierTime - ISO timestamp
 * @returns {string} - e.g., "2 seconds", "5 minutes", "3 hours", "2 days"
 */
const formatTimeGap = (laterTime, earlierTime) => {
  if (!laterTime || !earlierTime) return "unknown";

  const later = new Date(laterTime);
  const earlier = new Date(earlierTime);
  const diffMs = later - earlier;

  if (diffMs < 0) return "before";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? "s" : ""}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  return `${seconds} second${seconds !== 1 ? "s" : ""}`;
};

/**
 * Format message content by replacing DSL mentions with clean @mentions
 * Converts <!member_group:uuid|name> to @name
 */
const formatMessageContent = (content) => {
  if (!content) return "";

  // Replace <!member_group:uuid|name> with @name
  return content.replace(/<!member_group:[^|]+\|([^>]+)>/g, "@$1");
};

// Robust JSON parsing
const parseJSONSafe = (text) => {
  // Remove markdown code fences
  let cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Try to find JSON object or array
  let jsonStart = cleaned.indexOf("{");
  let jsonEnd = cleaned.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON object found in response:\n${text.slice(0, 500)}`);
  }

  let jsonStr = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try to fix common issues
    let fixed = jsonStr
      .replace(/,(\s*[}\]])/g, "$1") // Remove trailing commas
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); // Quote unquoted keys

    try {
      return JSON.parse(fixed);
    } catch (e2) {
      throw new Error(
        `JSON parse error: ${e.message}\n\nExtracted JSON:\n${jsonStr.slice(
          0,
          1000
        )}...`
      );
    }
  }
};

// ============================================
// SPEECH ACT CLASSIFICATION SCHEMA
// ============================================

/**
 * Speech act taxonomy for message classification
 * Based on dialogue act classes for team communication
 */
const SPEECH_ACT_SCHEMA = {
  Query: [
    "Query-Status",
    "Query-Status-Personal",
    "Query-Status-Environment",
    "Query-Status-TaskOrIssue",
    "Query-Technical",
    "Query-Admin",
    "Query-Through-Uncertainty",
    "Query-For-Clarification",
  ],
  Assign: ["Assign-Task", "Assign-Admin"],
  Request: ["Request", "Request-Help", "Request-Attention"],
  Inform: [
    "Inform-Status-Personal",
    "Inform-Status-Environment",
    "Inform-Status-TaskOrIssue",
    "Inform-Status-TaskOrIssue-Progress",
    "Inform-Status-TaskOrIssue-Impediment",
    "Inform-NewIssue",
    "Inform-NewIssue-Anticipated",
    "Inform-Technical",
    "Inform-Admin",
    "Inform-InResponse",
    "Inform-ExplainRationale",
    "Inform-ClaimTask",
    "Inform-ClaimProblemResponsibility",
  ],
  Propose: [
    "Propose-Task",
    "Propose-PossibleSolution",
    "Propose-OfferAssistance",
    "Propose-Admin",
  ],
  Acknowledge: [
    "Acknowledge-Receipt",
    "Acknowledge-Accept",
    "Acknowledge-Affirm",
    "Acknowledge-Validated",
  ],
  Reject: [
    "Reject",
    "Reject-Counter-Assign",
    "Reject-Counter-Inform",
    "Reject-Counter-Claim",
    "Reject-Counter-Propose",
  ],
  Code: ["Code-Message-Table-Issue", "Code-Message-Table-Solution"],
  Social: [
    "Social-Blame-Person",
    "Social-Backchannel",
    "Social-Comradery",
    "Social-Appreciation",
    "Social-Frustration",
  ],
};

// Color mapping for speech act categories
const speechActColors = {
  Query: { bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500" },
  Assign: {
    bg: "bg-orange-100",
    text: "text-orange-700",
    dot: "bg-orange-500",
  },
  Request: {
    bg: "bg-yellow-100",
    text: "text-yellow-700",
    dot: "bg-yellow-600",
  },
  Inform: { bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500" },
  Propose: {
    bg: "bg-purple-100",
    text: "text-purple-700",
    dot: "bg-purple-500",
  },
  Acknowledge: { bg: "bg-teal-100", text: "text-teal-700", dot: "bg-teal-500" },
  Reject: { bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500" },
  Code: { bg: "bg-gray-100", text: "text-gray-700", dot: "bg-gray-500" },
  Social: { bg: "bg-pink-100", text: "text-pink-700", dot: "bg-pink-500" },
};

// ============================================
// LLM SEGMENTATION: DATA STRUCTURES
// ============================================

/**
 * @typedef {Object} SpeechAct
 * @property {string} top_level - Top-level category (Query, Inform, Assign, Request, Propose, Acknowledge, Reject, Social, Code)
 * @property {string} specific - Specific act within the category
 */

/**
 * @typedef {Object} MessageAnnotation
 * @property {string} messageId
 * @property {string} conversationId - channel or DM
 * @property {string|null} attachesTo - message ID or null if new conversation
 * @property {string} segmentId
 * @property {'INITIATES'|'DEVELOPS'|'RESPONDS'|'RESOLVES'|'REACTS'} role
 * @property {number} confidence
 * @property {'STRUCTURAL'|'LLM'} method
 * @property {string} reasoning
 * @property {SpeechAct|null} speechAct - Speech act classification
 * @property {Date} annotatedAt
 */

/**
 * @typedef {Object} Segment
 * @property {string} id
 * @property {string} conversationId
 * @property {string[]} messageIds
 * @property {'OPEN'|'RESOLVED'|'STALE'} status
 * @property {string} summary - brief description for LLM context
 * @property {string[]} participants
 * @property {Date} createdAt
 * @property {Date} lastActivityAt
 * @property {Object[]} messages - full message objects
 * @property {MessageAnnotation[]} annotations - annotations for messages in this segment
 */

/**
 * @typedef {Object} ConversationState
 * @property {string} conversationId
 * @property {Segment[]} activeSegments
 */

/**
 * Creates a new segment from a message
 * @param {Object} message
 * @param {ConversationState} state
 * @returns {Segment}
 */
const createSegment = (message, state) => {
  const segment = {
    id: generateUUID(),
    conversationId: message.conversation_id,
    messageIds: [message.id],
    status: "OPEN",
    summary: generateSegmentSummary(message),
    participants: [message.author],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    messages: [message],
    annotations: [],
  };
  state.activeSegments.push(segment);
  return segment;
};

/**
 * Generate a brief summary from a message
 * @param {Object} message
 * @returns {string}
 */
const generateSegmentSummary = (message) => {
  // Format content first to replace mentions, then truncate
  const formatted = formatMessageContent(message.content || "");
  const text = formatted.slice(0, 50);
  return text.length < formatted.length ? `${text}...` : text;
};

/**
 * Find segment containing a specific message ID
 * @param {string} messageId
 * @param {ConversationState} state
 * @returns {Segment|undefined}
 */
const findSegmentContaining = (messageId, state) => {
  return state.activeSegments.find((s) => s.messageIds.includes(messageId));
};

/**
 * Get short UUID identifier for a segment (first 6 chars)
 * @param {Segment} segment
 * @returns {string}
 */
const getSegmentShortId = (segment) => {
  return segment?.id?.slice(0, 6) || "??????";
};

/**
 * Find segment by short UUID prefix
 * @param {string} shortId
 * @param {ConversationState} state
 * @returns {Segment|undefined}
 */
const findSegmentByShortId = (shortId, state) => {
  return state.activeSegments.find((s) => s.id.startsWith(shortId));
};

/**
 * Update segment state after a message is classified
 * @param {Object} message
 * @param {MessageAnnotation} annotation
 * @param {ConversationState} state
 */
const updateSegmentState = (message, annotation, state) => {
  const segment = state.activeSegments.find(
    (s) => s.id === annotation.segmentId
  );
  if (!segment) return;

  // Add message to segment if not already there
  if (!segment.messageIds.includes(message.id)) {
    segment.messageIds.push(message.id);
    segment.messages.push(message);
  }

  segment.lastActivityAt = new Date();
  segment.annotations.push(annotation);

  // Update participants
  if (!segment.participants.includes(message.author)) {
    segment.participants.push(message.author);
  }

  // Update status based on role
  if (annotation.role === "RESOLVES") {
    segment.status = "RESOLVED";
  }
};

// ============================================
// LLM SEGMENTATION: STRUCTURAL SIGNALS
// ============================================

/**
 * Find segment containing a specific thread_id (for thread replies)
 * Looks for segments where any message has the same thread_id
 * @param {string} threadId
 * @param {ConversationState} state
 * @returns {Segment|undefined}
 */
const findSegmentByThreadId = (threadId, state) => {
  return state.activeSegments.find((s) =>
    s.messages.some((m) => m.thread_id === threadId || m.id === threadId)
  );
};

/**
 * Check for structural signals that determine message attachment deterministically
 * @param {Object} message
 * @param {ConversationState} state
 * @returns {MessageAnnotation|null}
 */
const checkStructuralSignals = (message, state) => {
  // NOTE: Thread replies are NO LONGER handled structurally.
  // Threads can contain multiple topics, so we use LLM classification
  // to determine which segment each thread message belongs to.
  // The LLM prompt includes thread context to make informed decisions.

  // Emoji reactions - attach to target message
  // Note: Check if message is a reaction (usually very short emoji-only content)
  if (message.isReaction && message.reactedToId) {
    const segment = findSegmentContaining(message.reactedToId, state);
    const segmentId = segment?.id ?? createSegment(message, state).id;

    return {
      messageId: message.id,
      conversationId: message.conversation_id,
      attachesTo: message.reactedToId,
      segmentId: segmentId,
      role: "REACTS",
      confidence: 1.0,
      method: "STRUCTURAL",
      reasoning: "Emoji reaction",
      speechAct: { top_level: "Social", specific: "Social-Appreciation" },
      annotatedAt: new Date(),
    };
  }

  return null;
};

// ============================================
// LLM SEGMENTATION: CLASSIFICATION
// ============================================

const SEGMENTATION_SYSTEM_PROMPT = `You are a conversation analyst for a workplace chat platform. Your task is to determine how each new message relates to ongoing conversations in a channel.

A channel can have multiple simultaneous conversations. Messages belong to the same conversation when they discuss the SAME SPECIFIC ISSUE (not just the same general topic).

BE AGGRESSIVE ABOUT CREATING NEW SEGMENTS:
- Different PRs = different segments (PR #123 ≠ PR #124)
- Different bugs = different segments
- Different questions = different segments  
- A new announcement = new segment
- When unsure, lean toward creating NEW segment

TEMPORAL PROXIMITY - USE WITH CAUTION:
- Brief reactions ("lol", "nice", "W", "+1") sent immediately after another message → same segment
- BUT a new question or topic 30 seconds later = NEW segment (timing doesn't override content)
- Don't merge unrelated messages just because they're close in time

WHEN TO CREATE A NEW TOPIC (use "NEW"):
- A new bug report, error, or issue being raised
- A new PR/code review announcement  
- A new question (even if related to same general area)
- A new feature discussion or announcement
- Any message discussing a DIFFERENT specific issue
- Even if in the same thread, a different issue = new topic

IMPORTANT: Thread replies can contain MULTIPLE TOPICS.
- Do NOT assume all messages in a thread belong to the same segment.
- Analyze the CONTENT - if it discusses a different issue, it's a NEW topic.
- A PR about "inbox error" is DIFFERENT from a discussion about "stack grouping".

RESOLUTION SIGNALS (use RESOLVES role):
- "Fixed", "Done", "Resolved", "Completed"
- "You can close this", "Close this out", "This is done"
- "LGTM", "Approved", "Merged"
- "Thanks, that worked", acknowledgement that issue is solved

ROLE DEFINITIONS:
- INITIATES: Starts a new topic (new bug, new PR, new question, new feature discussion)
- DEVELOPS: Adds information to the SAME SPECIFIC issue (more details about THAT issue)
- RESPONDS: Directly answers a question about the SAME SPECIFIC issue
- RESOLVES: Closes out a conversation (fix confirmed, PR merged, issue closed)
- REACTS: Brief reaction without substance (emoji-like responses, "nice", "lol", "W")

Respond with JSON only.`;

/**
 * Build the user prompt for LLM classification
 * @param {Object} message
 * @param {ConversationState} state
 * @param {Object[]} recentMessages
 * @returns {string}
 */
const buildSegmentationPrompt = (message, state, recentMessages) => {
  // Find the immediately previous message for temporal context
  const messageIndex = recentMessages.findIndex((m) => m.id === message.id);
  const prevMessage =
    messageIndex > 0 ? recentMessages[messageIndex - 1] : null;
  const timeSincePrev = prevMessage
    ? formatTimeGap(message.created_at, prevMessage.created_at)
    : null;

  // Find which segment the previous message belongs to
  const prevMessageSegment = prevMessage
    ? state.activeSegments.find((s) => s.messageIds.includes(prevMessage.id))
    : null;
  const prevSegmentShortId = prevMessageSegment
    ? getSegmentShortId(prevMessageSegment)
    : null;

  const conversationBlocks = state.activeSegments
    .map((segment) => {
      const shortId = getSegmentShortId(segment);
      const segmentMessages = recentMessages
        .filter((m) => segment.messageIds.includes(m.id))
        .slice(-10); // last 10 messages per conversation

      const messageLines = segmentMessages
        .map((m) => `    [${m.id.slice(0, 8)}] ${m.author}: ${m.content}`)
        .join("\n");

      const status = segment.status === "RESOLVED" ? "RESOLVED" : "OPEN";

      // Calculate staleness - time since last message in this segment
      const lastMsgInSegment = segmentMessages[segmentMessages.length - 1];
      const staleness = lastMsgInSegment
        ? formatTimeGap(message.created_at, lastMsgInSegment.created_at)
        : "unknown";

      return `[${shortId}] ${segment.summary}
    Status: ${status}
    Last activity: ${staleness} ago
    Participants: ${segment.participants.join(", ")}
    Messages:
${messageLines || "    (no messages shown)"}`;
    })
    .join("\n\n");

  const conversationsSection =
    state.activeSegments.length > 0 ? conversationBlocks : "(none)";

  const options = state.activeSegments
    .map((s) => `- ${getSegmentShortId(s)}: ${s.summary}`)
    .concat(["- NEW: Starts a new conversation/topic"])
    .join("\n");

  const channelName = message.conversation_name || "channel";

  // Build thread context if this is a thread reply
  let threadContext = "";
  if (message.thread_id) {
    const threadMessages = recentMessages
      .filter(
        (m) => m.thread_id === message.thread_id || m.id === message.thread_id
      )
      .slice(-8); // Show last 8 messages from the thread

    if (threadMessages.length > 0) {
      const threadLines = threadMessages
        .map((m) => `    ${m.author}: ${m.content}`)
        .join("\n");

      threadContext = `
THREAD CONTEXT (this message is a reply in a thread):
${threadLines}

NOTE: Threads can contain multiple topics. Analyze the CONTENT to determine 
which conversation this message belongs to, not just the thread structure.

---

`;
    }
  }

  // Build previous message context for temporal proximity
  let prevMessageContext = "";
  if (prevMessage) {
    prevMessageContext = `
IMMEDIATELY PREVIOUS MESSAGE (${timeSincePrev} ago)${
      prevSegmentShortId ? ` [Segment ${prevSegmentShortId}]` : ""
    }:
${prevMessage.author}: "${prevMessage.content}"

`;
  }

  return `ACTIVE CONVERSATIONS IN #${channelName}:

${conversationsSection}

---
${threadContext}${prevMessageContext}NEW MESSAGE TO CLASSIFY:
[${message.id.slice(0, 8)}] ${message.author}: ${message.content}${
    message.thread_id ? " (thread reply)" : ""
  }

---

Which conversation does this message belong to?

OPTIONS:
${options}

Respond with JSON:
{
  "conversation": "<segment_id or NEW>",
  "attachesTo": "<message_id or null>",
  "role": "INITIATES" | "DEVELOPS" | "RESPONDS" | "RESOLVES" | "REACTS",
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence>"
}`;
};

/**
 * Build prompt for previous-topic-centric strategy
 * For thread replies: compare to the thread's topic
 * For non-thread messages: compare to the chronologically previous topic
 */
const buildPreviousMessagePrompt = (
  message,
  state,
  recentMessages,
  allPreviousMessages,
  config
) => {
  const channelName = message.conversation_name || "channel";

  // Determine the "reference topic" based on whether this is a thread reply
  let referenceSegment = null;
  let referenceMessage = null;
  let isThreadReply = false;

  if (message.thread_id) {
    // This is a THREAD REPLY - find the thread root in ALL previous messages
    isThreadReply = true;
    const threadRoot = allPreviousMessages.find(
      (m) => m.id === message.thread_id
    );

    if (threadRoot) {
      referenceMessage = threadRoot;
      referenceSegment = state.activeSegments.find((s) =>
        s.messageIds.includes(threadRoot.id)
      );
    }
  }

  // If not a thread reply, or thread root not found, use chronologically previous message
  if (!referenceSegment) {
    const prevMessage =
      recentMessages.length > 0
        ? recentMessages[recentMessages.length - 1]
        : null;
    if (prevMessage) {
      referenceMessage = prevMessage;
      referenceSegment = state.activeSegments.find((s) =>
        s.messageIds.includes(prevMessage.id)
      );
    }
  }

  const referenceSegmentShortId = referenceSegment
    ? getSegmentShortId(referenceSegment)
    : null;

  const timeSinceRef = referenceMessage
    ? formatTimeGap(message.created_at, referenceMessage.created_at)
    : null;

  // Build the topic section
  let topicSection = "";
  const topicLabel = isThreadReply ? "THREAD TOPIC" : "PREVIOUS TOPIC";

  if (referenceSegment) {
    // Get all messages from this segment for full context
    const segmentMessages = recentMessages
      .filter((m) => referenceSegment.messageIds.includes(m.id))
      .slice(-15); // Last 15 messages from this topic

    const messageHistory = segmentMessages
      .map((m) => {
        const timeAgo = formatTimeGap(message.created_at, m.created_at);
        return `  [${timeAgo} ago] ${m.author}: "${m.content}"`;
      })
      .join("\n");

    topicSection = `${topicLabel} [Segment ${referenceSegmentShortId}]:
Summary: ${referenceSegment.summary}
Participants: ${referenceSegment.participants.join(", ")}

Message History:
${messageHistory}

`;
  } else if (referenceMessage) {
    // No segment yet (first message scenario)
    topicSection = `${topicLabel} (${timeSinceRef} ago):
${referenceMessage.author}: "${referenceMessage.content}"

`;
  } else {
    topicSection = "No previous messages (this is the first message).\n\n";
  }

  // For thread replies, provide strong guidance to stay with the thread's topic
  const threadGuidance = isThreadReply
    ? `

⚠️ IMPORTANT: This is a THREAD REPLY. Thread replies should ALMOST ALWAYS attach to their thread's topic (Segment ${
        referenceSegmentShortId || "??????"
      }).
Only use "NEW" if the message is discussing something COMPLETELY UNRELATED to the thread topic.
Questions, reactions, follow-ups, tangents - these all belong to the thread's topic.

`
    : "";

  return `#${channelName}

${topicSection}${threadGuidance}NEW MESSAGE TO CLASSIFY:
${message.author}: "${message.content}"

---

${
  isThreadReply
    ? `This is a THREAD REPLY. Attach to the thread's topic (Segment ${referenceSegmentShortId}) unless COMPLETELY unrelated.`
    : `Is this message about THE SAME SPECIFIC ISSUE as the previous topic?
- Same issue = attach to Segment ${referenceSegmentShortId || "??????"}
- Different issue (new bug, new PR, new question) = NEW
Note: Keyword overlap is NOT enough! "DMs" in two messages doesn't mean same topic.`
}

Respond with JSON:
{
  "continues_previous": true | false,
  "segment": "${referenceSegmentShortId || "NEW"}" | "NEW",
  "speech_act": "<specific dialogue act label from the taxonomy>",
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence>"
}`;
};

/**
 * Build prompt for hybrid strategy
 * Combines previous message focus with recent segments
 */
const buildHybridPrompt = (message, state, recentMessages, config) => {
  const messageIndex = recentMessages.findIndex((m) => m.id === message.id);
  const prevMessage =
    messageIndex > 0 ? recentMessages[messageIndex - 1] : null;
  const timeSincePrev = prevMessage
    ? formatTimeGap(message.created_at, prevMessage.created_at)
    : null;

  const prevMessageSegment = prevMessage
    ? state.activeSegments.find((s) => s.messageIds.includes(prevMessage.id))
    : null;
  const prevSegmentShortId = prevMessageSegment
    ? getSegmentShortId(prevMessageSegment)
    : null;

  const channelName = message.conversation_name || "channel";

  // Filter segments by staleness and limit
  const currentTime = new Date(message.created_at);
  const stalenessMs = config.stalenessThreshold * 60 * 1000;

  const recentSegments = state.activeSegments
    .map((segment, index) => {
      const segmentMessages = recentMessages.filter((m) =>
        segment.messageIds.includes(m.id)
      );
      const lastMsg = segmentMessages[segmentMessages.length - 1];
      const lastMsgTime = lastMsg ? new Date(lastMsg.created_at) : null;
      const ageMs = lastMsgTime ? currentTime - lastMsgTime : Infinity;
      const isStale = ageMs > stalenessMs;

      return { segment, index, ageMs, isStale, lastMsg };
    })
    .filter((s) => !s.isStale || s.segment.id === prevMessageSegment?.id)
    .sort((a, b) => a.ageMs - b.ageMs)
    .slice(0, config.maxSegmentsToShow);

  // Build segment blocks for recent segments only
  const conversationBlocks = recentSegments
    .map(({ segment, ageMs, lastMsg }) => {
      const shortId = getSegmentShortId(segment);
      const ageStr = formatTimeGap(message.created_at, lastMsg?.created_at);
      const segmentMessages = recentMessages
        .filter((m) => segment.messageIds.includes(m.id))
        .slice(-5);

      const messageLines = segmentMessages
        .map((m) => `    ${m.author}: ${m.content}`)
        .join("\n");

      return `[${shortId}] ${segment.summary}
    Last activity: ${ageStr} ago
    Messages:
${messageLines || "    (no messages)"}`;
    })
    .join("\n\n");

  // Thread context
  let threadContext = "";
  if (message.thread_id) {
    const threadMessages = recentMessages
      .filter(
        (m) => m.thread_id === message.thread_id || m.id === message.thread_id
      )
      .slice(-5);

    if (threadMessages.length > 0) {
      threadContext = `
THREAD CONTEXT:
${threadMessages.map((m) => `  ${m.author}: "${m.content}"`).join("\n")}

`;
    }
  }

  // Previous message section (emphasized in hybrid mode)
  const prevMsgSection =
    prevMessage && config.preferPreviousMessage
      ? `
>>> IMMEDIATELY PREVIOUS MESSAGE (${timeSincePrev} ago) [Segment ${
          prevSegmentShortId || "??????"
        }]:
>>> ${prevMessage.author}: "${prevMessage.content}"
>>> Messages sent close together usually belong to the same conversation!

`
      : "";

  const options = recentSegments
    .map(({ segment }) => `- ${getSegmentShortId(segment)}`)
    .concat(["- NEW: Starts a new conversation"])
    .join("\n");

  return `RECENT CONVERSATIONS IN #${channelName}:

${conversationBlocks || "(none active recently)"}

---
${threadContext}${prevMsgSection}NEW MESSAGE TO CLASSIFY:
${message.author}: "${message.content}"

---

OPTIONS:
${options}

Respond with JSON:
{
  "conversation": "<segment_id or NEW>",
  "role": "INITIATES" | "DEVELOPS" | "RESPONDS" | "RESOLVES" | "REACTS",
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence>"
}`;
};

/**
 * Get the top-level category from a specific speech act label
 * @param {string} specificAct - e.g., "Query-Technical", "Inform-NewIssue"
 * @returns {string} - top-level category e.g., "Query", "Inform"
 */
const getSpeechActCategory = (specificAct) => {
  if (!specificAct) return null;

  // Find which category contains this specific act
  for (const [category, acts] of Object.entries(SPEECH_ACT_SCHEMA)) {
    if (acts.includes(specificAct)) {
      return category;
    }
  }

  // Fallback: extract from the label prefix (e.g., "Query-Technical" -> "Query")
  const prefix = specificAct.split("-")[0];
  if (SPEECH_ACT_SCHEMA[prefix]) {
    return prefix;
  }

  return null;
};

/**
 * Parse LLM response for classification
 * @param {string} response
 * @returns {Object}
 */
const parseClassificationResponse = (response) => {
  const parsed = parseJSONSafe(response);

  // Handle previous-centric format (uses continues_previous/segment instead of conversation)
  const conversation = parsed.conversation || parsed.segment;

  // Validate required fields - speech_act is now the primary classification
  if (!conversation) {
    throw new Error("Missing required fields in LLM response");
  }

  // Parse speech_act - can be a string or object
  let speechAct = null;
  if (parsed.speech_act) {
    if (typeof parsed.speech_act === "string") {
      const category = getSpeechActCategory(parsed.speech_act);
      speechAct = {
        top_level: category || parsed.speech_act.split("-")[0],
        specific: parsed.speech_act,
      };
    } else {
      speechAct = parsed.speech_act;
    }
  }

  return {
    conversation: conversation,
    continues_previous: parsed.continues_previous ?? false,
    attachesTo: parsed.attachesTo ?? null,
    role: parsed.role ?? "DEVELOPS", // Keep for backward compatibility
    confidence: parsed.confidence ?? 0.5,
    reasoning: parsed.reasoning ?? "",
    speechAct: speechAct,
  };
};

/**
 * Classify a message using LLM
 * @param {Object} message
 * @param {ConversationState} state
 * @param {Object[]} recentMessages
 * @param {string} apiKey
 * @returns {Promise<MessageAnnotation>}
 */
const classifyWithLLM = async (
  message,
  state,
  recentMessages,
  allPreviousMessages,
  apiKey,
  model,
  strategyConfig = {}
) => {
  // Default strategy config
  const config = {
    strategy: "segment-centric",
    stalenessThreshold: 30,
    maxSegmentsToShow: 5,
    preferPreviousMessage: true,
    ...strategyConfig,
  };

  // Find reference segment - for thread replies, use thread root's segment; otherwise use previous message's segment
  let referenceMessage = null;
  let referenceSegment = null;

  if (message.thread_id) {
    // Thread reply - find the thread root in ALL previous messages (not just recent 50)
    const threadRoot = allPreviousMessages.find(
      (m) => m.id === message.thread_id
    );
    console.log(
      `[THREAD DEBUG] Message "${message.content?.slice(
        0,
        30
      )}..." has thread_id: ${message.thread_id}`
    );
    console.log(
      `[THREAD DEBUG] Found thread root in allPreviousMessages: ${
        threadRoot ? "YES" : "NO"
      } (searched ${allPreviousMessages.length} messages)`
    );

    if (threadRoot) {
      referenceMessage = threadRoot;
      referenceSegment = state.activeSegments.find((s) =>
        s.messageIds.includes(threadRoot.id)
      );
      console.log(
        `[THREAD DEBUG] Thread root: "${threadRoot.content?.slice(
          0,
          30
        )}..." by ${threadRoot.author}`
      );
      console.log(
        `[THREAD DEBUG] Found segment for thread root: ${
          referenceSegment ? "YES - " + referenceSegment.id : "NO"
        }`
      );
      if (!referenceSegment) {
        console.log(
          `[THREAD DEBUG] Active segments:`,
          state.activeSegments.map((s) => ({
            id: s.id.slice(-8),
            messageIds: s.messageIds,
            summary: s.summary?.slice(0, 30),
          }))
        );
      }
    }
  }

  // Fallback to chronologically previous message if not a thread reply or thread root not found
  if (!referenceSegment) {
    console.log(
      `[THREAD DEBUG] Using fallback: chronologically previous message`
    );
    referenceMessage =
      recentMessages.length > 0
        ? recentMessages[recentMessages.length - 1]
        : null;
    if (referenceMessage) {
      referenceSegment = state.activeSegments.find((s) =>
        s.messageIds.includes(referenceMessage.id)
      );
      console.log(
        `[THREAD DEBUG] Fallback message: "${referenceMessage.content?.slice(
          0,
          30
        )}..." → segment: ${referenceSegment?.id?.slice(-8)}`
      );
    }
  }

  const referenceSegmentShortId = referenceSegment
    ? getSegmentShortId(referenceSegment)
    : null;

  // Build prompt based on strategy
  let prompt;
  let systemPrompt = SEGMENTATION_SYSTEM_PROMPT;

  if (config.strategy === "previous-centric") {
    prompt = buildPreviousMessagePrompt(
      message,
      state,
      recentMessages,
      allPreviousMessages,
      config
    );
    systemPrompt = `You are analyzing chat messages to determine if they continue a previous TOPIC or start a new topic.

A TOPIC is a conversation about a SPECIFIC ISSUE or subject. You will be shown:
1. The previous topic's summary
2. The full message history from that topic
3. The new message to classify

CRITICAL RULES:

1. SAME TOPIC = SAME SPECIFIC ISSUE
   - Topics are NOT about keyword overlap! Two messages mentioning "DMs" could be totally different issues.
   - Ask: "Is this message about THE SAME SPECIFIC ISSUE as the previous topic?"
   - Example: "Stack evals from DMs" vs "DM notifications not working" = DIFFERENT topics (both mention DMs but different issues)
   - Example: "PR #323 review" vs "PR #324 review" = DIFFERENT topics (different PRs)

2. THREAD REPLIES: If marked as a THREAD REPLY, ALMOST ALWAYS attach to the thread's topic.
   - Questions, tangents, reactions within a thread = same topic
   - Only use NEW if COMPLETELY UNRELATED to the thread

3. NON-THREAD MESSAGES: Evaluate if it's the SAME SPECIFIC ISSUE as the previous topic.
   - New bug reports, new PRs, new questions = likely NEW topic
   - Reactions/follow-ups to the immediately previous message = likely same topic

4. EXPLICIT REFERENCE INDICATORS:
   - "^" or "^ same" or "^^ this" = ALWAYS refers to the IMMEDIATELY PREVIOUS message's topic
   - "+1" or "agreed" without context = reaction to immediately previous message
   - These should attach to the PREVIOUS topic shown, not jump to other topics

5. DIALOGUE ACT CLASSIFICATION: Classify each message using ONE specific label from this taxonomy:

   QUERY (asking questions):
   - Query-Status, Query-Status-Personal, Query-Status-Environment, Query-Status-TaskOrIssue
   - Query-Technical, Query-Admin, Query-Through-Uncertainty, Query-For-Clarification

   ASSIGN (delegating work): Assign-Task, Assign-Admin

   REQUEST (asking for action): Request, Request-Help, Request-Attention

   INFORM (sharing information):
   - Inform-Status-Personal, Inform-Status-Environment, Inform-Status-TaskOrIssue
   - Inform-Status-TaskOrIssue-Progress, Inform-Status-TaskOrIssue-Impediment
   - Inform-NewIssue, Inform-NewIssue-Anticipated, Inform-Technical, Inform-Admin
   - Inform-InResponse, Inform-ExplainRationale, Inform-ClaimTask, Inform-ClaimProblemResponsibility

   PROPOSE (suggesting): Propose-Task, Propose-PossibleSolution, Propose-OfferAssistance, Propose-Admin

   ACKNOWLEDGE (confirming): Acknowledge-Receipt, Acknowledge-Accept, Acknowledge-Affirm, Acknowledge-Validated

   REJECT (declining): Reject, Reject-Counter-Assign, Reject-Counter-Inform, Reject-Counter-Claim, Reject-Counter-Propose

   CODE (code content): Code-Message-Table-Issue, Code-Message-Table-Solution

   SOCIAL (non-work): Social-Blame-Person, Social-Backchannel, Social-Comradery, Social-Appreciation, Social-Frustration

Respond with JSON only.`;
  } else if (config.strategy === "hybrid") {
    prompt = buildHybridPrompt(message, state, recentMessages, config);
  } else {
    // segment-centric (current/default)
    prompt = buildSegmentationPrompt(message, state, recentMessages);
  }

  try {
    const response = await callAnthropic(
      apiKey,
      systemPrompt,
      prompt,
      200,
      model
    );

    const result = parseClassificationResponse(response);

    // Handle previous-centric response format
    if (config.strategy === "previous-centric") {
      // Check if continuing previous/thread topic or new
      const continuesPrev =
        result.continues_previous ||
        (result.segment && result.segment !== "NEW");

      if (continuesPrev && referenceSegment) {
        return {
          messageId: message.id,
          conversationId: message.conversation_id,
          attachesTo: referenceMessage?.id || null,
          segmentId: referenceSegment.id,
          role: result.role,
          confidence: result.confidence,
          method: "LLM",
          reasoning: result.reasoning,
          speechAct: result.speechAct,
          annotatedAt: new Date(),
        };
      } else {
        // New topic
        const newSegment = createSegment(message, state);
        return {
          messageId: message.id,
          conversationId: message.conversation_id,
          attachesTo: null,
          segmentId: newSegment.id,
          role: result.role || "INITIATES",
          confidence: result.confidence,
          method: "LLM",
          reasoning: result.reasoning,
          speechAct: result.speechAct,
          annotatedAt: new Date(),
        };
      }
    }

    // Handle segment-centric and hybrid response format
    // Handle NEW conversation
    if (result.conversation === "NEW") {
      const newSegment = createSegment(message, state);
      return {
        messageId: message.id,
        conversationId: message.conversation_id,
        attachesTo: null,
        segmentId: newSegment.id,
        role: result.role,
        confidence: result.confidence,
        method: "LLM",
        reasoning: result.reasoning,
        speechAct: result.speechAct,
        annotatedAt: new Date(),
      };
    }

    // Attach to existing conversation by UUID prefix
    const segment = findSegmentByShortId(result.conversation, state);

    if (!segment) {
      // Fallback: try to find most recent segment if segment ID is invalid
      const fallbackSegment =
        state.activeSegments[state.activeSegments.length - 1];

      if (fallbackSegment && result.role !== "INITIATES") {
        return {
          messageId: message.id,
          conversationId: message.conversation_id,
          attachesTo: result.attachesTo,
          segmentId: fallbackSegment.id,
          role: result.role,
          confidence: result.confidence * 0.7,
          method: "LLM",
          reasoning: `${result.reasoning} (attached to most recent segment due to invalid ID ${result.conversation})`,
          speechAct: result.speechAct,
          annotatedAt: new Date(),
        };
      }

      // Create new segment if no fallback available or role is INITIATES
      const newSegment = createSegment(message, state);
      return {
        messageId: message.id,
        conversationId: message.conversation_id,
        attachesTo: null,
        segmentId: newSegment.id,
        role: result.role,
        confidence: result.confidence * 0.5,
        method: "LLM",
        reasoning: `${result.reasoning} (new segment: invalid ID ${result.conversation})`,
        speechAct: result.speechAct,
        annotatedAt: new Date(),
      };
    }

    return {
      messageId: message.id,
      conversationId: message.conversation_id,
      attachesTo: result.attachesTo,
      segmentId: segment.id,
      role: result.role,
      confidence: result.confidence,
      method: "LLM",
      reasoning: result.reasoning,
      speechAct: result.speechAct,
      annotatedAt: new Date(),
    };
  } catch (error) {
    console.error("LLM classification failed:", error);

    // Fallback: create new segment
    const newSegment = createSegment(message, state);
    return {
      messageId: message.id,
      conversationId: message.conversation_id,
      attachesTo: null,
      segmentId: newSegment.id,
      role: "INITIATES",
      confidence: 0.0,
      method: "LLM",
      reasoning: `Fallback due to classification error: ${error.message}`,
      speechAct: null,
      annotatedAt: new Date(),
    };
  }
};

/**
 * Main segmentation function - processes messages sequentially
 * @param {Object[]} messages - sorted messages
 * @param {string} apiKey
 * @param {string} model
 * @param {Object} strategyConfig - strategy configuration
 * @param {Function} onProgress - callback for progress updates
 * @param {Function} addDebugLog - callback for debug logs
 * @returns {Promise<{segments: Segment[], annotations: MessageAnnotation[]}>}
 */
const segmentMessages = async (
  messages,
  apiKey,
  model,
  strategyConfig,
  onProgress,
  addDebugLog
) => {
  // Initialize state per conversation
  const statesByConversation = new Map();
  const allAnnotations = [];

  const getOrCreateState = (conversationId) => {
    if (!statesByConversation.has(conversationId)) {
      statesByConversation.set(conversationId, {
        conversationId,
        activeSegments: [],
      });
    }
    return statesByConversation.get(conversationId);
  };

  // Sort messages chronologically
  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  for (let i = 0; i < sorted.length; i++) {
    const message = sorted[i];
    const state = getOrCreateState(message.conversation_id);

    // Get all previous messages in this conversation for thread root lookup
    const allPreviousMessages = sorted
      .slice(0, i)
      .filter((m) => m.conversation_id === message.conversation_id);

    // Get recent messages for context (last 50 in this conversation)
    const recentMessages = allPreviousMessages.slice(-50);

    onProgress(
      i + 1,
      sorted.length,
      `Processing message ${i + 1}/${sorted.length}`
    );

    // Step 1: Check structural signals
    let annotation = checkStructuralSignals(message, state);

    if (annotation) {
      addDebugLog({
        title: `Message ${i + 1}: Structural`,
        request: `${message.author}: "${message.content?.slice(0, 50)}..."`,
        response: `${annotation.method}: ${annotation.reasoning} → Segment ${
          getSegmentShortId(
            state.activeSegments.find((s) => s.id === annotation.segmentId)
          ) || "NEW"
        }`,
      });
    } else {
      // Step 2: LLM classification using configured strategy
      addDebugLog({
        title: `Message ${i + 1}: LLM (${
          strategyConfig.strategy || "segment-centric"
        })`,
        request: `${message.author}: "${message.content?.slice(0, 80)}..."`,
        response: "(processing...)",
      });

      annotation = await classifyWithLLM(
        message,
        state,
        recentMessages,
        allPreviousMessages,
        apiKey,
        model,
        strategyConfig
      );

      // Update debug log with response
      const segmentShortId =
        getSegmentShortId(
          state.activeSegments.find((s) => s.id === annotation.segmentId)
        ) || "??????";

      const speechActLabel = annotation.speechAct?.specific || "unknown";
      addDebugLog({
        title: `Message ${i + 1}: Result`,
        response: `${speechActLabel} → Segment ${segmentShortId} (${(
          annotation.confidence * 100
        ).toFixed(0)}%)\n${annotation.reasoning}`,
      });
    }

    // Step 3: Update segment state
    updateSegmentState(message, annotation, state);
    allAnnotations.push(annotation);

    // Small delay to avoid rate limits
    if (i < sorted.length - 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Collect all segments from all conversations
  const allSegments = [];
  for (const state of statesByConversation.values()) {
    allSegments.push(...state.activeSegments);
  }

  return {
    segments: allSegments,
    annotations: allAnnotations,
  };
};

// ============================================
// LEVEL 1: DETERMINISTIC ATOMIC UNITS
// ============================================

/**
 * Detect the data model format and extract messages
 * Supports:
 * - Format A: Nested workspace_event structure (original)
 * - Format B: Flat message array (new simpler format)
 */
const extractMessages = (data) => {
  if (!Array.isArray(data) || data.length === 0) {
    return [];
  }

  // Detect format by checking first item
  const sample = data[0];
  const isFormatA = !!sample?.workspace_event;
  const isFormatB = !!sample?.markdown_content && !!sample?.author_id;

  console.log(
    `Detected data format: ${
      isFormatA
        ? "A (nested workspace_event)"
        : isFormatB
        ? "B (flat message array)"
        : "Unknown"
    }`
  );

  // Build author name lookup from mentions in messages (for Format B)
  const authorNames = new Map();
  if (isFormatB) {
    // Extract author names from member mentions like <!member_group:uuid|Name>
    data.forEach((item) => {
      const content = item.markdown_content || "";
      const mentions = content.matchAll(/<!member_group:([^|]+)\|([^>]+)>/g);
      for (const match of mentions) {
        const memberId = match[1];
        const memberName = match[2];
        if (!authorNames.has(memberId)) {
          authorNames.set(memberId, memberName);
        }
      }
    });
  }

  // Get short ID for display (first 8 chars of UUID)
  const shortId = (id) => id?.slice(0, 8) || "unknown";

  const messages = data.map((item) => {
    if (isFormatA) {
      // Format A: Nested workspace_event structure
      const msg = item?.workspace_event?.message || {};
      const actor = item?.workspace_event?.actor_member || {};
      const conv = item?.workspace_event?.conversation || {};
      return {
        id: item.id,
        created_at: msg.created_at || "",
        content: msg.markdown_content || "",
        author: actor.display_name || "Unknown",
        authorId: actor.id || "",
        conversation_id: item?.workspace_event?.conversation_id || "",
        conversation_name: conv.name || "",
        thread_id: item?.workspace_event?.thread_root_id || null,
      };
    } else if (isFormatB) {
      // Format B: Flat message array
      const authorId = item.author_id || "";
      const conversationId = item.conversation_id || "";
      // Try hardcoded mapping first, then extracted mentions, then fallback
      const authorName =
        AUTHOR_ID_MAP[authorId] ||
        authorNames.get(authorId) ||
        `User-${shortId(authorId)}`;
      // Map conversation ID to channel name
      const conversationName = CONVERSATION_NAME_MAP[conversationId] || "";
      return {
        id: item.id,
        created_at: item.created_at || "",
        content: item.markdown_content || "",
        author: authorName,
        authorId: authorId,
        conversation_id: conversationId,
        conversation_name: conversationName,
        thread_id: item.thread_root_id || null,
      };
    } else {
      // Unknown format - try to extract what we can
      return {
        id: item.id || "",
        created_at: item.created_at || "",
        content: item.content || item.markdown_content || "",
        author: item.author || item.author_id || "Unknown",
        authorId: item.author_id || "",
        conversation_id: item.conversation_id || "",
        conversation_name: item.conversation_name || "",
        thread_id: item.thread_root_id || item.thread_id || null,
      };
    }
  });

  // First filter: must have id, created_at, AND non-empty content (skip images)
  const validMessages = messages.filter(
    (m) => m.id && m.created_at && m.content && m.content.trim().length > 0
  );

  // Get set of valid message IDs
  const validMessageIds = new Set(validMessages.map((m) => m.id));

  // Second filter: remove thread replies whose thread root was filtered out (empty/image)
  return validMessages.filter((m) => {
    if (!m.thread_id) return true; // Not a thread reply, keep it
    // Check if the thread root exists in the valid messages
    if (!validMessageIds.has(m.thread_id)) {
      console.log(
        `Filtering out thread reply "${m.content?.slice(
          0,
          30
        )}..." - thread root was empty/filtered`
      );
      return false;
    }
    return true;
  });
};

const isContinuationSignal = (msg) => {
  const content = msg.content?.toLowerCase().trim() || "";
  const shortPatterns = [
    /^(yeah|yea|ya|yep|yes|no|nope|ok|okay|k|kk|sure|agreed|exactly|right|true|lol|haha|hmm|ah|oh|nice|cool|great|thanks|ty|thx|\+1|\^|this|same|def|definitely|totally|yup|nah|word|bet|facts|fr|real|tru|omg|wow|ooh|ahh)$/i,
    /^.{1,10}$/,
  ];
  return shortPatterns.some((p) => p.test(content));
};

const isReplyLikeMessage = (msg, prevMsg) => {
  // Check if this message looks like a reply/response to the previous one
  const content = msg.content?.toLowerCase().trim() || "";
  const prevContent = prevMsg.content?.toLowerCase().trim() || "";

  // Strong reply signals
  const replyPatterns = [
    /^(yeah|yea|ya|yep|yes|exactly|right|agreed|sure|definitely|totally|same|this|that|true)$/i,
    /^(no|nope|nah|not really|disagree)$/i,
    /^(ok|okay|k|kk|got it|makes sense|understood)$/i,
    /^(thanks|thank you|ty|thx|appreciate it)$/i,
    /^(cool|nice|great|awesome|love it)$/i,
  ];

  // Check if message is a short reply-like response
  const isShortReply =
    replyPatterns.some((p) => p.test(content)) ||
    (content.length <= 20 &&
      /^(yeah|yes|no|ok|yep|exactly|right|same|this|that|true|sure|agreed)/i.test(
        content
      ));

  // Check if message STARTS with a reply word/phrase (even if longer)
  // This catches cases like "yeah - i think..." or "yes, that makes sense..."
  const startsWithReply =
    /^(yeah|yea|ya|yep|yes|no|nope|ok|okay|right|exactly|sure|agreed|definitely|totally|yup|nah)\s*[-,:;]?\s*/i.test(
      content
    );

  // Check if it references the previous message
  const referencesPrev =
    content.includes("this") ||
    content.includes("that") ||
    content.includes("same") ||
    (prevContent.length > 0 && content.length < prevContent.length * 0.3); // Very short relative to prev

  // Check for semantic continuation: shared keywords/topics
  // Extract meaningful words (3+ chars) from both messages
  const extractWords = (text) => {
    return text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  };

  const contentWords = new Set(extractWords(content));
  const prevWords = new Set(extractWords(prevContent));
  const sharedWords = [...contentWords].filter((w) => prevWords.has(w));

  // If message is short-medium length and shares significant keywords, it's likely a continuation
  const isSemanticContinuation =
    content.length <= 50 && // Short to medium length
    sharedWords.length > 0 && // Has shared words
    sharedWords.some((w) => w.length >= 4); // At least one meaningful shared word (4+ chars)

  // Also check if it's a short elaboration/clarification (very short relative to previous)
  const isShortElaboration =
    prevContent.length > 20 && // Previous message was substantial
    content.length <= 30 && // Current is short
    content.length < prevContent.length * 0.5; // Less than half the length

  return (
    isShortReply ||
    startsWithReply ||
    referencesPrev ||
    isSemanticContinuation ||
    isShortElaboration
  );
};

const createAtomicUnits = (messages) => {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  const units = [];
  let current = [];

  for (const msg of sorted) {
    if (current.length === 0) {
      current = [msg];
      continue;
    }

    const prev = current.at(-1);
    const firstInUnit = current[0];
    const timeDiff =
      (new Date(msg.created_at) - new Date(prev.created_at)) / 60000;
    const timeDiffFromFirst =
      (new Date(msg.created_at) - new Date(firstInUnit.created_at)) / 60000;
    const sameConv = msg.conversation_id === prev.conversation_id;
    const sameAuthor = msg.author === prev.author;
    const sameThread = msg.thread_id && msg.thread_id === prev.thread_id;

    // Check if this message's thread_id matches ANY message in the current unit
    // This handles cases where messages from different conversations interrupt a thread
    const hasMatchingThread =
      msg.thread_id &&
      current.some((m) => m.thread_id && m.thread_id === msg.thread_id);

    let extend = false;

    // Priority 1: Same thread (always extend)
    // Check both the last message AND any message in the current unit
    if (sameThread || hasMatchingThread) {
      extend = true;
    }
    // Priority 2: Temporal proximity (same author + <2min, or same conv + <1min)
    else if (sameAuthor && sameConv && timeDiff < 2) {
      extend = true;
    } else if (sameConv && timeDiff < 1) {
      extend = true;
    }
    // Priority 3: Continuation signals with moderate time gap
    else if (isContinuationSignal(msg) && sameConv && timeDiff < 3) {
      extend = true;
    }
    // Priority 4: Reply-like messages in same conversation (even with large time gaps)
    // Check against both the last message and the first message of the current unit
    // This handles async conversations where people respond hours/days later
    else if (sameConv) {
      const isReplyToLast = isReplyLikeMessage(msg, prev);
      const isReplyToFirst =
        current.length > 1 && isReplyLikeMessage(msg, firstInUnit);

      if (isReplyToLast || isReplyToFirst) {
        // For async replies, extend if within 24 hours
        // Check time from last message OR from first message (for longer conversations)
        const relevantTimeDiff = isReplyToLast ? timeDiff : timeDiffFromFirst;
        if (relevantTimeDiff < 1440) {
          // 24 hours
          extend = true;
        }
      }
    }

    if (extend) {
      current.push(msg);
    } else {
      // Before closing the current unit, check if the next message belongs to a thread
      // that exists in the current unit. If so, extend instead of closing.
      if (
        msg.thread_id &&
        current.some((m) => m.thread_id && m.thread_id === msg.thread_id)
      ) {
        current.push(msg);
      } else {
        // Also check if this message's thread matches any recent completed unit
        // This handles cases where messages from different conversations interrupt a thread
        let mergedIntoPreviousUnit = false;
        if (msg.thread_id && units.length > 0) {
          // Check the last few units (up to 5) for the same thread
          const unitsToCheck = units.slice(-5);
          for (let i = unitsToCheck.length - 1; i >= 0; i--) {
            const unit = unitsToCheck[i];
            const unitHasThread = unit.messages.some(
              (m) => m.thread_id && m.thread_id === msg.thread_id
            );
            if (unitHasThread) {
              // Merge this message into that unit instead of creating a new one
              const unitIndex = units.length - unitsToCheck.length + i;
              units[unitIndex] = createUnit([...unit.messages, msg], unitIndex);
              mergedIntoPreviousUnit = true;
              break;
            }
          }
        }
        if (!mergedIntoPreviousUnit) {
          units.push(createUnit(current, units.length));
          current = [msg];
        }
      }
    }
  }

  if (current.length > 0) {
    units.push(createUnit(current, units.length));
  }

  return units;
};

const createUnit = (messages, index) => ({
  id: generateUUID(),
  index,
  messages,
  authors: [...new Set(messages.map((m) => m.author))],
  conversation_id: messages[0].conversation_id,
  conversation_name: messages[0].conversation_name || "DM",
  start_time: messages[0].created_at,
  end_time: messages.at(-1).created_at,
  content: messages.map((m) => m.content).join(" "),
});

// ============================================
// API CALLS
// ============================================

const callAnthropic = async (
  apiKey,
  system,
  userMessage,
  maxTokens = 2000,
  model = "claude-3-5-haiku-20241022",
  timeoutMs = 120000
) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        error.error?.message || `API call failed: ${response.status}`
      );
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
    }
    throw err;
  }
};

// ============================================
// LEVEL 1.5: VALIDATE AND ADJUST UNITS (BATCHED)
// ============================================

const BATCH_SIZE = 10;
const BATCH_OVERLAP = 3; // Overlap between batches to catch cross-boundary merges

const buildValidationPrompt = (units, batchStart) => {
  const system = `You validate and adjust message groupings into atomic units.
You are processing units ${batchStart + 1}-${
    batchStart + units.length
  } which are adjacent in the conversation timeline.

IMPORTANT: If adjacent units (e.g., U32, U33, U34) discuss the same topic or theme, they should be MERGED into a single unit.
Focus on semantic similarity - units discussing the same concept, question, or topic should be merged even if there are time gaps between them.

For each unit:
1. Check coherence: Are all messages in this unit about the same topic?
2. Check splitting: Does the topic change mid-unit? (split if needed)
3. Check merging: Does this unit discuss the same topic as adjacent units in this batch? (merge if yes)

Reply with ONLY valid JSON. No markdown, no extra text.`;

  const unitDescriptions = units
    .map((u, i) => {
      const unitNum = batchStart + i + 1;
      const msgList = u.messages
        .map((m, j) => `  [${unitNum}.${j + 1}] ${m.author}: "${m.content}"`)
        .join("\n");
      const timeRange =
        u.messages.length > 0
          ? ` (${formatShortTime(u.messages[0].created_at)} - ${formatShortTime(
              u.messages[u.messages.length - 1].created_at
            )})`
          : "";
      return `UNIT ${unitNum} [${
        u.conversation_name || "DM"
      }]${timeRange}:\n${msgList}`;
    })
    .join("\n\n");

  const userMessage = `Validate these ${
    units.length
  } adjacent message units (units ${batchStart + 1}-${
    batchStart + units.length
  }):

${unitDescriptions}

For each unit, determine:
1. Is it coherent? (all messages same topic)
2. Should it split? (topic changes mid-unit)
3. Should it merge with adjacent units? (same topic/theme - MERGE if semantically related)

PRIORITY: If units are adjacent and discuss the same topic (e.g., continuing a conversation about the same subject), merge them.

Reply with ONLY this JSON:
{
  "analysis": [
    {"unit": ${batchStart + 1}, "action": "keep", "reason": "..."},
    {"unit": ${
      batchStart + 2
    }, "action": "split", "split_after_message": [2], "reason": "..."},
    {"unit": ${batchStart + 3}, "action": "merge", "merge_with_units": [${
    batchStart + 4
  }], "reason": "..."}
  ]
}

Actions: "keep", "split", or "merge"
- split: set split_after_message to array of message indices (1-based) where to split
- merge: set merge_with_units to array of unit numbers to merge with (can merge multiple adjacent units)`;

  return { system, userMessage };
};

const applyBatchAdjustments = (units, analysis, batchStart) => {
  if (!analysis || !Array.isArray(analysis)) {
    return units;
  }

  // Normalize unit numbers to batch-relative indices
  const getLocalIndex = (unitNum) => unitNum - batchStart - 1;

  const mergeGroups = new Map();
  const toMerge = new Set();

  for (const item of analysis) {
    if (item.action === "merge" && item.merge_with_units?.length > 0) {
      const localIdx = getLocalIndex(item.unit);
      const group = [
        localIdx,
        ...item.merge_with_units.map((u) => getLocalIndex(u)),
      ]
        .filter((i) => i >= 0 && i < units.length)
        .sort((a, b) => a - b);

      if (group.length > 1) {
        const key = group[0];
        if (!mergeGroups.has(key)) {
          mergeGroups.set(key, group);
          group.forEach((i) => toMerge.add(i));
        }
      }
    }
  }

  const adjustedUnits = [];
  const processed = new Set();

  for (let i = 0; i < units.length; i++) {
    if (processed.has(i)) continue;

    const unitNum = batchStart + i + 1;
    const item = analysis.find((a) => a.unit === unitNum) || { action: "keep" };
    const unit = units[i];

    if (mergeGroups.has(i)) {
      // Merge units
      const group = mergeGroups.get(i);
      const mergedMessages = group
        .flatMap((idx) => units[idx]?.messages || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      if (mergedMessages.length > 0) {
        adjustedUnits.push({
          ...createUnit(mergedMessages, 0),
          mergedFrom: group.map((idx) => batchStart + idx + 1),
        });
      }
      group.forEach((idx) => processed.add(idx));
    } else if (
      item.action === "split" &&
      item.split_after_message?.length > 0
    ) {
      // Split unit
      const splitPoints = item.split_after_message
        .filter((s) => s > 0 && s < unit.messages.length)
        .sort((a, b) => a - b);

      let start = 0;
      for (const splitAt of [...splitPoints, unit.messages.length]) {
        if (start < splitAt) {
          adjustedUnits.push({
            ...createUnit(unit.messages.slice(start, splitAt), 0),
            splitFrom: unitNum,
            splitRange: [start + 1, splitAt],
          });
        }
        start = splitAt;
      }
      processed.add(i);
    } else if (!toMerge.has(i)) {
      // Keep as-is
      adjustedUnits.push({ ...unit });
      processed.add(i);
    }
  }

  return adjustedUnits;
};

// Post-merge pass: Check adjacent units that might need merging across batch boundaries
const postMergeAdjacentUnits = async (
  units,
  apiKey,
  model,
  addDebugLog,
  updateLastDebugLog
) => {
  if (units.length <= 1) return units;

  addDebugLog({
    title: "Step 2: Semantic Regroup Post-Merge",
    request: `Checking ${units.length} groups for adjacent merges...`,
    response: "(processing...)",
  });

  // Check pairs of adjacent units
  const mergeCandidates = [];
  const BATCH_SIZE = 20; // Process in larger batches for post-merge

  for (let i = 0; i < units.length - 1; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, units.length - 1);
    const pairs = [];

    for (let j = i; j < batchEnd; j++) {
      pairs.push({ unit1: j, unit2: j + 1 });
    }

    if (pairs.length === 0) continue;

    const pairDescriptions = pairs
      .map(({ unit1, unit2 }) => {
        const u1 = units[unit1];
        const u2 = units[unit2];
        return `PAIR ${unit1 + 1}-${unit2 + 1}:
UNIT ${unit1 + 1}: ${u1.messages
          .map((m) => `${m.author}: "${m.content}"`)
          .join(" | ")}
UNIT ${unit2 + 1}: ${u2.messages
          .map((m) => `${m.author}: "${m.content}"`)
          .join(" | ")}`;
      })
      .join("\n\n");

    const system = `You check if adjacent units should be merged.
If two adjacent units discuss the same topic/theme, they should be merged.
Focus on semantic similarity, not just temporal proximity.

Reply with ONLY valid JSON. No markdown, no extra text.`;

    const userMessage = `Check these ${pairs.length} adjacent unit pairs:

${pairDescriptions}

For each pair, determine if they should be merged (same topic/theme).

Reply ONLY:
{
  "pairs": [
    {"unit1": ${i + 1}, "unit2": ${
      i + 2
    }, "should_merge": true/false, "reason": "..."},
    ...
  ]
}`;

    try {
      const response = await callAnthropic(
        apiKey,
        system,
        userMessage,
        1000,
        model
      );
      const result = parseJSONSafe(response);

      if (result.pairs && Array.isArray(result.pairs)) {
        result.pairs.forEach((pair) => {
          if (pair.should_merge && pair.unit1 && pair.unit2) {
            const idx1 = pair.unit1 - 1;
            const idx2 = pair.unit2 - 1;
            if (idx1 >= 0 && idx2 < units.length && idx2 === idx1 + 1) {
              mergeCandidates.push({ idx1, idx2 });
            }
          }
        });
      }
    } catch (err) {
      // Continue if API call fails
      console.warn("Post-merge API call failed:", err);
    }
  }

  // Apply merges (process in reverse order to maintain indices)
  if (mergeCandidates.length === 0) {
    updateLastDebugLog({ response: "No adjacent merges needed" });
    return units;
  }

  const merged = new Set();
  const result = [];

  for (let i = 0; i < units.length; i++) {
    if (merged.has(i)) continue;

    const mergeGroup = [i];
    let currentIdx = i;

    // Find chain of merges
    while (true) {
      const merge = mergeCandidates.find(
        (m) => m.idx1 === currentIdx && !merged.has(m.idx2)
      );
      if (merge) {
        mergeGroup.push(merge.idx2);
        merged.add(merge.idx2);
        currentIdx = merge.idx2;
      } else {
        break;
      }
    }

    if (mergeGroup.length > 1) {
      // Merge the group
      const mergedMessages = mergeGroup
        .flatMap((idx) => units[idx]?.messages || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      if (mergedMessages.length > 0) {
        result.push({
          ...createUnit(mergedMessages, result.length),
          mergedFrom: mergeGroup.map((idx) => idx + 1),
        });
      }
      mergeGroup.forEach((idx) => merged.add(idx));
    } else {
      result.push({ ...units[i], index: result.length });
    }
  }

  updateLastDebugLog({
    response: `Merged ${mergeCandidates.length} adjacent pairs: ${units.length} → ${result.length} units`,
  });

  return result;
};

// ============================================
// LEVEL 2: STACK FORMATION
// ============================================

const buildStackAssignmentPrompt = (unit, stacks) => {
  const system = `You assign message units to stacks based on semantic topic similarity.
IMPORTANT: Units can be semantically related even if they are far apart in time. 
Focus on whether they discuss the same topic, concept, or theme - not just temporal proximity.
If a unit discusses the same topic as an existing stack, join it even if the messages are hours or days apart.

Reply with ONLY valid JSON. No markdown, no extra text.`;

  const stacksDesc =
    stacks.length === 0
      ? "(none yet - create new)"
      : stacks
          .map((s, i) => {
            // Show more messages for better context - all if stack is small, otherwise up to 10
            const messageCount = s.messages.length;
            const messagesToShow =
              messageCount <= 10
                ? s.messages
                : [
                    ...s.messages.slice(0, 5), // First 5
                    ...s.messages.slice(-2), // Last 2
                  ];

            const sample = messagesToShow
              .map((m) => `    ${m.author}: "${m.content}"`)
              .join("\n");
            const moreIndicator =
              messageCount > messagesToShow.length
                ? `\n    ... (${
                    messageCount - messagesToShow.length
                  } more messages)`
                : "";
            return `STACK ${i + 1}: "${s.title}"\n  ${
              s.summary
            }\n  Messages (${messageCount} total):\n${sample}${moreIndicator}`;
          })
          .join("\n\n");

  const unitMsgs = unit.messages
    .map((m) => `  ${m.author}: "${m.content}"`)
    .join("\n");

  const userMessage = `NEW UNIT [${unit.conversation_name || "DM"}]:
${unitMsgs}

EXISTING STACKS:
${stacksDesc}

Does this unit discuss the same topic as any existing stack? 
- If YES: join the most semantically similar stack (even if messages are far apart in time)
- If NO: create a new stack

Reply ONLY:
{"action": "join" or "create", "stack_index": <number if join>, "title": "<50 chars>", "summary": "<150 chars>"}`;

  return { system, userMessage };
};

// ============================================
// AUTHOR COLORS
// ============================================

const authorColorPalette = [
  { bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500" },
  { bg: "bg-emerald-100", text: "text-emerald-700", dot: "bg-emerald-500" },
  { bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500" },
  { bg: "bg-purple-100", text: "text-purple-700", dot: "bg-purple-500" },
  { bg: "bg-rose-100", text: "text-rose-700", dot: "bg-rose-500" },
  { bg: "bg-cyan-100", text: "text-cyan-700", dot: "bg-cyan-500" },
  { bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500" },
  { bg: "bg-indigo-100", text: "text-indigo-700", dot: "bg-indigo-500" },
];

const getAuthorColor = (author, colorMap) => {
  if (!colorMap[author]) {
    const idx = Object.keys(colorMap).length % authorColorPalette.length;
    colorMap[author] = authorColorPalette[idx];
  }
  return colorMap[author];
};

// ============================================
// COMPONENTS
// ============================================

const StepTabs = ({ currentStep, setCurrentStep, maxStep }) => {
  const steps = [
    { id: 0, label: "Input" },
    { id: 1, label: "Step 1: Building Blocks" },
    { id: 2, label: "Step 2: Semantic Regroup" },
    { id: 3, label: "Step 3: LLM Stack Formation" },
  ];

  return (
    <div className="flex border-b bg-white">
      {steps.map((step) => (
        <button
          key={step.id}
          onClick={() => step.id <= maxStep && setCurrentStep(step.id)}
          disabled={step.id > maxStep}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            currentStep === step.id
              ? "border-blue-500 text-blue-600 bg-blue-50"
              : step.id <= maxStep
              ? "border-transparent text-gray-600 hover:text-gray-800 hover:bg-gray-50"
              : "border-transparent text-gray-300 cursor-not-allowed"
          }`}
        >
          {step.label}
        </button>
      ))}
    </div>
  );
};

const ProgressBar = ({ current, total, label }) => (
  <div className="space-y-1">
    <div className="flex justify-between text-xs text-gray-500">
      <span>{label}</span>
      <span>
        {current}/{total}
      </span>
    </div>
    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
      <div
        className="h-full bg-blue-500 transition-all duration-300"
        style={{ width: `${(current / total) * 100}%` }}
      />
    </div>
  </div>
);

const MessageBubble = ({
  message,
  colorMap,
  compact = false,
  showGroupIndex = false,
}) => {
  const colors = getAuthorColor(message.author, colorMap);
  return (
    <div className={`flex gap-2 ${compact ? "py-0.5" : "py-1"}`}>
      <div
        className={`${
          compact ? "w-5 h-5 text-[10px]" : "w-6 h-6 text-xs"
        } rounded-full ${
          colors.dot
        } flex items-center justify-center text-white flex-shrink-0`}
      >
        {message.author.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className={`${compact ? "text-[10px]" : "text-xs"} font-medium ${
              colors.text
            }`}
          >
            {message.author}
          </span>
          <span
            className={`${compact ? "text-[10px]" : "text-xs"} text-gray-400`}
          >
            {formatShortTime(message.created_at)}
          </span>
          <span
            onClick={() => navigator.clipboard.writeText(message.id)}
            className={`${
              compact ? "text-[10px]" : "text-xs"
            } text-gray-300 font-mono cursor-pointer hover:text-blue-500 hover:underline`}
            title="Click to copy"
          >
            {message.id}
          </span>
          {showGroupIndex && message.groupId && (
            <span
              className={`${
                compact ? "text-[10px]" : "text-xs"
              } bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium font-mono`}
              title={message.groupId}
            >
              {message.groupId?.slice(0, 6)}
            </span>
          )}
        </div>
        <p
          className={`${
            compact ? "text-xs" : "text-sm"
          } text-gray-700 break-words`}
        >
          {formatMessageContent(message.content) || (
            <span className="italic text-gray-400">[empty]</span>
          )}
        </p>
      </div>
    </div>
  );
};

const UnitCard = ({ unit, colorMap, highlight, badge }) => {
  const [expanded, setExpanded] = useState(false);
  const hasMore = unit.messages.length > 2;
  const messagesToShow = expanded ? unit.messages : unit.messages.slice(0, 2);
  const unitShortId = unit.id?.slice(0, 6) || "??????";

  return (
    <div
      className={`p-2 rounded-lg border ${
        highlight ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-400" title={unit.id}>
            {unitShortId}
          </span>
          <span className="text-[10px] text-gray-400">
            #{unit.conversation_name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {badge && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${badge.color}`}
            >
              {badge.text}
            </span>
          )}
          <span className="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">
            {unit.messages.length}
          </span>
        </div>
      </div>
      <div className="space-y-0.5">
        {messagesToShow.map((m) => (
          <MessageBubble key={m.id} message={m} colorMap={colorMap} compact />
        ))}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-blue-600 hover:text-blue-800 pl-7 mt-0.5 text-left hover:underline"
          >
            {expanded
              ? "▼ Show less"
              : `▼ Show ${unit.messages.length - 2} more`}
          </button>
        )}
      </div>
    </div>
  );
};

// Role color mapping for annotations
const roleColors = {
  INITIATES: {
    bg: "bg-green-100",
    text: "text-green-700",
    dot: "bg-green-500",
  },
  DEVELOPS: { bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500" },
  RESPONDS: {
    bg: "bg-purple-100",
    text: "text-purple-700",
    dot: "bg-purple-500",
  },
  RESOLVES: {
    bg: "bg-emerald-100",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  REACTS: { bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500" },
};

const statusColors = {
  OPEN: { bg: "bg-blue-50", border: "border-blue-300", text: "text-blue-700" },
  RESOLVED: {
    bg: "bg-green-50",
    border: "border-green-300",
    text: "text-green-700",
  },
  STALE: { bg: "bg-gray-50", border: "border-gray-300", text: "text-gray-500" },
};

const SegmentCard = ({ segment, index, colorMap, annotations }) => {
  const [expanded, setExpanded] = useState(false);
  const hasMore = segment.messages.length > 3;
  const messagesToShow = expanded
    ? segment.messages
    : segment.messages.slice(0, 3);
  const status = statusColors[segment.status] || statusColors.OPEN;

  // Get annotation for a message
  const getAnnotation = (messageId) => {
    return annotations?.find((a) => a.messageId === messageId);
  };

  return (
    <div className={`p-3 rounded-lg border-2 ${status.bg} ${status.border}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-gray-700 font-mono">
            {segment.id?.slice(0, 6) || "??????"}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${status.text} ${status.bg}`}
          >
            {segment.status}
          </span>
          <span className="text-[10px] text-gray-400">
            #{segment.messages[0]?.conversation_name || "DM"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] bg-white/50 px-1.5 py-0.5 rounded">
            {segment.messages.length} msgs
          </span>
          <span className="text-[10px] bg-white/50 px-1.5 py-0.5 rounded">
            {segment.participants.length} people
          </span>
        </div>
      </div>

      <div className="text-xs text-gray-600 mb-2 italic">{segment.summary}</div>

      <div className="space-y-1">
        {messagesToShow.map((m) => {
          const annotation = getAnnotation(m.id);
          const actColor =
            speechActColors[annotation?.speechAct?.top_level] ||
            speechActColors.Inform;

          return (
            <div key={m.id} className="bg-white/70 rounded p-1.5">
              <div className="flex items-start gap-2">
                <div
                  className={`w-1 h-full min-h-[20px] rounded ${actColor.dot}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-medium text-gray-700">
                      {m.author}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {formatShortTime(m.created_at)}
                    </span>
                    {annotation?.speechAct && (
                      <span
                        className={`text-[9px] px-1 py-0.5 rounded ${actColor.bg} ${actColor.text}`}
                      >
                        {annotation.speechAct.specific}
                        {annotation.method === "STRUCTURAL" && " (auto)"}
                      </span>
                    )}
                    {annotation && (
                      <span className="text-[9px] text-gray-400">
                        {(annotation.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-700 break-words">
                    {m.content || (
                      <span className="italic text-gray-400">[empty]</span>
                    )}
                  </p>
                  {annotation?.reasoning && (
                    <p className="text-[9px] text-gray-400 mt-0.5 italic">
                      {annotation.reasoning}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-blue-600 hover:text-blue-800 mt-1 text-left hover:underline"
          >
            {expanded
              ? "▲ Show less"
              : `▼ Show ${segment.messages.length - 3} more messages`}
          </button>
        )}
      </div>
    </div>
  );
};

// ============================================
// SLACK-LIKE TIMELINE COMPONENTS
// ============================================

const ConversationSidebar = ({
  conversations,
  selectedId,
  onSelect,
  llmSegments,
  llmAnnotations,
}) => {
  // Count segments per conversation
  const getSegmentCount = (conversationId) => {
    const messageIds =
      conversations
        .find((c) => c.id === conversationId)
        ?.messages.map((m) => m.id) || [];
    const segmentIds = new Set();
    llmAnnotations.forEach((a) => {
      if (messageIds.includes(a.messageId)) {
        segmentIds.add(a.segmentId);
      }
    });
    return segmentIds.size;
  };

  // Get display name for conversation
  const getConversationLabel = (conv) => {
    if (conv.isChannel) {
      return `#${conv.name}`;
    }
    // For DMs, show participants
    if (conv.participants && conv.participants.length > 0) {
      return conv.participants.join(", ");
    }
    return "DM";
  };

  return (
    <div className="w-56 border-r bg-gray-50 flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b bg-white">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Conversations
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations.map((conv) => {
          const isSelected = conv.id === selectedId;
          const segmentCount = getSegmentCount(conv.id);
          const label = getConversationLabel(conv);

          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`w-full px-3 py-2 text-left transition-colors ${
                isSelected
                  ? "bg-blue-100 border-l-4 border-blue-500"
                  : "hover:bg-gray-100 border-l-4 border-transparent"
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-sm truncate ${
                    isSelected ? "font-semibold text-blue-900" : "text-gray-700"
                  }`}
                >
                  {conv.isChannel ? label : `@${label}`}
                </span>
                <span className="flex items-center gap-1 flex-shrink-0 ml-2">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      isSelected
                        ? "bg-blue-200 text-blue-800"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {conv.messages.length}
                  </span>
                  {segmentCount > 0 && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        isSelected
                          ? "bg-purple-200 text-purple-800"
                          : "bg-purple-100 text-purple-600"
                      }`}
                    >
                      {segmentCount}
                    </span>
                  )}
                </span>
              </div>
              {!conv.isChannel &&
                conv.participants &&
                conv.participants.length > 2 && (
                  <div className="text-[10px] text-gray-400 mt-0.5 truncate">
                    {conv.participants.length} participants
                  </div>
                )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const TimelineMessage = ({
  message,
  annotation,
  segment,
  segmentColor,
  isThreadReply,
  colorMap,
}) => {
  const authorColor = getAuthorColor(message.author, colorMap);
  const speechActColor =
    speechActColors[annotation?.speechAct?.top_level] || speechActColors.Inform;
  const segmentShortId = segment?.id?.slice(0, 6) || "??????";

  return (
    <div
      className={`flex gap-3 py-1.5 px-3 hover:bg-gray-50 transition-colors ${
        isThreadReply ? "ml-10 border-l-2 border-gray-200" : ""
      }`}
    >
      {/* Segment indicator - per message */}
      <div
        className={`w-auto min-w-[2rem] h-6 px-1 rounded flex items-center justify-center text-[10px] font-mono font-bold flex-shrink-0 ${
          segmentColor?.bg || "bg-gray-100"
        } ${segmentColor?.text || "text-gray-600"}`}
        title={`Segment ${segmentShortId}`}
      >
        {segmentShortId}
      </div>

      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-full ${authorColor.dot} flex items-center justify-center text-white text-sm font-medium flex-shrink-0`}
      >
        {message.author.charAt(0).toUpperCase()}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-sm font-semibold ${authorColor.text}`}>
            {message.author}
          </span>
          <span className="text-xs text-gray-400">
            {formatTime(message.created_at)}
          </span>

          {/* Annotation badge - speech act classification */}
          {annotation?.speechAct && (
            <>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${speechActColor.bg} ${speechActColor.text}`}
              >
                {annotation.speechAct.specific}
              </span>
              <span className="text-[10px] text-gray-400">
                {(annotation.confidence * 100).toFixed(0)}%
              </span>
            </>
          )}

          {/* Thread indicator */}
          {isThreadReply && (
            <span className="text-[10px] text-gray-400">(thread)</span>
          )}
        </div>

        {/* Message content */}
        <p className="text-sm text-gray-800 mt-0.5 whitespace-pre-wrap break-words">
          {formatMessageContent(message.content) || (
            <span className="italic text-gray-400">[empty message]</span>
          )}
        </p>

        {/* Reasoning (if available) */}
        {annotation?.reasoning && (
          <p className="text-xs text-gray-400 mt-1 italic">
            → {annotation.reasoning}
          </p>
        )}
      </div>
    </div>
  );
};

const SegmentDivider = ({ segment, segmentColor }) => {
  const segmentShortId = segment?.id?.slice(0, 6) || "??????";
  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 ${
        segmentColor?.bg || "bg-gray-50"
      } border-l-4 ${segmentColor?.border || "border-l-gray-300"}`}
    >
      <div
        className={`text-sm font-bold font-mono ${
          segmentColor?.text || "text-gray-600"
        }`}
      >
        Segment {segmentShortId}
      </div>
      <div className="flex-1 h-px bg-current opacity-20" />
      <div className="text-xs text-gray-500">{segment.summary}</div>
      <div
        className={`text-[10px] px-1.5 py-0.5 rounded ${
          segment.status === "RESOLVED"
            ? "bg-green-100 text-green-700"
            : segment.status === "STALE"
            ? "bg-gray-100 text-gray-500"
            : "bg-blue-100 text-blue-700"
        }`}
      >
        {segment.status}
      </div>
      <div className="text-xs text-gray-400">
        {segment.messages.length} msgs · {segment.participants.length} people
      </div>
    </div>
  );
};

const MessageTimeline = ({
  conversation,
  llmSegments,
  llmAnnotations,
  getAnnotationForMessage,
  getSegmentForMessage,
  getSegmentIndex,
  getSegmentColor,
  colorMap,
}) => {
  const [showSegmentPanel, setShowSegmentPanel] = useState(true);

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <div className="text-center">
          <div className="text-lg mb-2">Select a conversation</div>
          <div className="text-sm">Choose a channel or DM from the sidebar</div>
        </div>
      </div>
    );
  }

  const messages = conversation.messages;

  // Organize messages: identify thread roots and thread replies
  // Thread roots are messages with no thread_id OR messages that are referenced as thread_id by others
  const threadRootIds = new Set(
    messages.filter((m) => m.thread_id).map((m) => m.thread_id)
  );

  // Create a map of thread_id -> replies
  const threadReplies = new Map();
  messages.forEach((msg) => {
    if (msg.thread_id) {
      if (!threadReplies.has(msg.thread_id)) {
        threadReplies.set(msg.thread_id, []);
      }
      threadReplies.get(msg.thread_id).push(msg);
    }
  });

  // Get top-level messages (no thread_id, or is itself a thread root)
  const topLevelMessages = messages.filter((msg) => !msg.thread_id);

  // Build message info with segment data
  const buildMessageInfo = (msg, isThreadReply = false) => {
    const annotation = getAnnotationForMessage(msg.id);
    const segment = annotation ? getSegmentForMessage(msg.id) : null;
    const segmentId = segment?.id || null;
    const segmentIndex = segment ? getSegmentIndex(segmentId) : -1;
    const segmentColor = segment ? getSegmentColor(segmentId) : null;

    return {
      message: msg,
      annotation,
      segment,
      segmentIndex,
      segmentColor,
      isThreadReply,
    };
  };

  // Get unique segments in this conversation for the header
  const conversationSegments = [
    ...new Set(
      messages
        .map((m) => getAnnotationForMessage(m.id))
        .filter(Boolean)
        .map((a) => getSegmentForMessage(a.messageId)?.id)
        .filter(Boolean)
    ),
  ]
    .map((id) => llmSegments.find((s) => s.id === id))
    .filter(Boolean);

  // Export data as JSON for analysis
  const handleExportJSON = () => {
    // Build export data structure
    const exportData = {
      conversation: {
        id: conversation.id,
        name: conversation.name,
        isChannel: conversation.isChannel,
        messageCount: messages.length,
        topicCount: conversationSegments.length,
      },
      topics: conversationSegments.map((segment) => {
        const segmentMessages = messages.filter((m) =>
          segment.messageIds.includes(m.id)
        );
        return {
          id: segment.id,
          shortId: segment.id.slice(0, 6),
          summary: segment.summary,
          status: segment.status,
          participants: segment.participants,
          messageCount: segmentMessages.length,
          messages: segmentMessages.map((m) => {
            const annotation = getAnnotationForMessage(m.id);
            return {
              id: m.id,
              author: m.author,
              content: m.content,
              created_at: m.created_at,
              thread_id: m.thread_id || null,
              annotation: annotation
                ? {
                    speechAct: annotation.speechAct?.specific || null,
                    speechActCategory: annotation.speechAct?.top_level || null,
                    confidence: annotation.confidence,
                    reasoning: annotation.reasoning,
                  }
                : null,
            };
          }),
        };
      }),
      // Aggregate stats by participant and speech act
      participantStats: (() => {
        const stats = {};
        messages.forEach((m) => {
          const annotation = getAnnotationForMessage(m.id);
          const speechAct = annotation?.speechAct?.specific || "unknown";
          const category = annotation?.speechAct?.top_level || "unknown";

          if (!stats[m.author]) {
            stats[m.author] = {
              totalMessages: 0,
              byCategory: {},
              bySpeechAct: {},
            };
          }
          stats[m.author].totalMessages++;
          stats[m.author].byCategory[category] =
            (stats[m.author].byCategory[category] || 0) + 1;
          stats[m.author].bySpeechAct[speechAct] =
            (stats[m.author].bySpeechAct[speechAct] || 0) + 1;
        });
        return stats;
      })(),
      exportedAt: new Date().toISOString(),
    };

    // Download as JSON file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${conversation.name}-topics-export.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Conversation Header */}
        <div className="px-4 py-2 border-b bg-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold text-gray-800">
              {conversation.isChannel ? "#" : "@"}
              {conversation.name}
            </span>
            <span className="text-sm text-gray-500">
              {conversation.messages.length} messages
            </span>
            {conversationSegments.length > 0 && (
              <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                {conversationSegments.length} topics
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportJSON}
              className="text-xs px-2 py-1 rounded transition-colors bg-blue-100 text-blue-700 hover:bg-blue-200"
              title="Export topics and annotations as JSON"
            >
              Export JSON
            </button>
            <button
              onClick={() => setShowSegmentPanel(!showSegmentPanel)}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                showSegmentPanel
                  ? "bg-purple-100 text-purple-700"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {showSegmentPanel ? "Hide" : "Show"} Topics
            </button>
          </div>
        </div>

        {/* Messages with thread structure */}
        <div className="flex-1 overflow-y-auto bg-white">
          <div className="py-4">
            {topLevelMessages.map((msg) => {
              const msgInfo = buildMessageInfo(msg, false);
              const replies = threadReplies.get(msg.id) || [];
              const hasReplies = replies.length > 0;

              return (
                <React.Fragment key={msg.id}>
                  {/* Main message */}
                  <TimelineMessage
                    message={msgInfo.message}
                    annotation={msgInfo.annotation}
                    segment={msgInfo.segment}
                    segmentColor={msgInfo.segmentColor}
                    isThreadReply={false}
                    colorMap={colorMap}
                  />

                  {/* Thread replies */}
                  {hasReplies && (
                    <div className="mb-2">
                      {replies.map((reply) => {
                        const replyInfo = buildMessageInfo(reply, true);
                        return (
                          <TimelineMessage
                            key={reply.id}
                            message={replyInfo.message}
                            annotation={replyInfo.annotation}
                            segment={replyInfo.segment}
                            segmentColor={replyInfo.segmentColor}
                            isThreadReply={true}
                            colorMap={colorMap}
                          />
                        );
                      })}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Collapsible Segment Panel */}
      {showSegmentPanel && conversationSegments.length > 0 && (
        <div className="w-64 border-l bg-gray-50 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b bg-white">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Topics ({conversationSegments.length})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {conversationSegments.map((seg) => {
              const color = getSegmentColor(seg.id);
              const segmentShortId = seg.id?.slice(0, 6) || "??????";
              return (
                <div
                  key={seg.id}
                  className={`p-2 rounded-lg border-l-4 ${color.border} ${color.bg}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-sm font-bold font-mono ${color.text}`}
                    >
                      {segmentShortId}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        seg.status === "RESOLVED"
                          ? "bg-green-100 text-green-700"
                          : seg.status === "STALE"
                          ? "bg-gray-100 text-gray-500"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {seg.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-700 line-clamp-2">
                    {seg.summary}
                  </p>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                    <span>{seg.messages.length} msgs</span>
                    <span>·</span>
                    <span>{seg.participants.join(", ")}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const StackCard = ({ stack, index, colorMap, expanded, onToggle }) => {
  // Get unique group IDs (short UUIDs) for this stack
  const groupIds = [
    ...new Set(stack.messages.map((m) => m.groupId).filter(Boolean)),
  ];
  const stackShortId = stack.id?.slice(0, 6) || "??????";

  return (
    <div className="border rounded-lg bg-white overflow-hidden">
      <div
        onClick={onToggle}
        className="p-3 cursor-pointer hover:bg-gray-50 flex items-start justify-between gap-2"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-mono text-gray-400" title={stack.id}>
              {stackShortId}
            </span>
            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
              {stack.messages.length} msgs
            </span>
            {groupIds.length > 0 && (
              <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-mono">
                {groupIds.length === 1
                  ? groupIds[0]?.slice(0, 6)
                  : `${groupIds.length} groups`}
              </span>
            )}
          </div>
          <h3 className="font-medium text-sm text-gray-800 truncate">
            {stack.title}
          </h3>
          <p className="text-xs text-gray-500 truncate">{stack.summary}</p>
        </div>
        <span className="text-gray-400 text-sm">{expanded ? "▼" : "▶"}</span>
      </div>
      {expanded && (
        <div className="border-t p-2 bg-gray-50 space-y-0.5 max-h-48 overflow-y-auto">
          {stack.messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              colorMap={colorMap}
              compact
              showGroupIndex
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Strategy Configuration Panel for LLM Segmentation
 */
const StrategyConfigPanel = ({ config, setConfig }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const strategies = [
    {
      id: "segment-centric",
      name: "Segment-Centric",
      desc: "Shows all segments, picks best match",
    },
    {
      id: "previous-centric",
      name: "Previous-Topic",
      desc: "Classify relative to the previous topic",
    },
    {
      id: "hybrid",
      name: "Hybrid",
      desc: "Previous message + recent segments",
    },
    {
      id: "single-prompt",
      name: "Single Prompt",
      desc: "One call with all messages, returns all stacks",
    },
  ];

  return (
    <div className="border rounded-lg bg-gray-50 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-700">Strategy:</span>
          <span className="text-purple-600 font-medium">
            {strategies.find((s) => s.id === config.strategy)?.name || "Hybrid"}
          </span>
        </div>
        <span className="text-gray-400">{isExpanded ? "▼" : "▶"}</span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-4 border-t bg-white">
          {/* Strategy Selection */}
          <div className="pt-3">
            <label className="block text-xs font-medium text-gray-500 mb-2">
              Classification Strategy
            </label>
            <div className="space-y-1">
              {strategies.map((s) => (
                <label
                  key={s.id}
                  className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                    config.strategy === s.id
                      ? "bg-purple-50 border border-purple-200"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="strategy"
                    value={s.id}
                    checked={config.strategy === s.id}
                    onChange={(e) =>
                      setConfig({ ...config, strategy: e.target.value })
                    }
                    className="text-purple-600"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-700">
                      {s.name}
                    </div>
                    <div className="text-xs text-gray-500">{s.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* These options only apply to segment-centric and hybrid strategies */}
          {config.strategy !== "previous-centric" &&
            config.strategy !== "single-prompt" && (
              <>
                {/* Staleness Threshold - only for hybrid */}
                {config.strategy === "hybrid" && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Staleness Threshold: {config.stalenessThreshold} min
                    </label>
                    <input
                      type="range"
                      min="5"
                      max="120"
                      step="5"
                      value={config.stalenessThreshold}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          stalenessThreshold: parseInt(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                    <div className="flex justify-between text-[10px] text-gray-400">
                      <span>5 min</span>
                      <span>Segments older than this are deprioritized</span>
                      <span>120 min</span>
                    </div>
                  </div>
                )}

                {/* Max Segments - for segment-centric and hybrid */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    Max Segments to Show: {config.maxSegmentsToShow}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={config.maxSegmentsToShow}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        maxSegmentsToShow: parseInt(e.target.value),
                      })
                    }
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-gray-400">
                    <span>1</span>
                    <span>Fewer = faster, more focused</span>
                    <span>10</span>
                  </div>
                </div>

                {/* Prefer Previous Message - only for hybrid */}
                {config.strategy === "hybrid" && (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium text-gray-500">
                        Prefer Previous Message
                      </div>
                      <div className="text-[10px] text-gray-400">
                        Strongly weight the immediately preceding message
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.preferPreviousMessage}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            preferPreviousMessage: e.target.checked,
                          })
                        }
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                    </label>
                  </div>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
};

const DebugLog = ({ log }) => (
  <div className="border border-gray-700 rounded bg-gray-800 overflow-hidden text-xs">
    <div className="px-2 py-1 bg-gray-700 font-medium text-gray-200 flex justify-between">
      <span>{log.title}</span>
      <span className="text-gray-400">
        {new Date(log.timestamp).toLocaleTimeString()}
      </span>
    </div>
    <div className="p-2 space-y-2 font-mono max-h-48 overflow-y-auto">
      {log.system && (
        <div>
          <div className="text-purple-400 mb-0.5">SYSTEM:</div>
          <pre className="text-gray-400 whitespace-pre-wrap text-[10px]">
            {log.system}
          </pre>
        </div>
      )}
      {log.request && (
        <div>
          <div className="text-blue-400 mb-0.5">REQUEST:</div>
          <pre className="text-gray-400 whitespace-pre-wrap text-[10px]">
            {log.request}
          </pre>
        </div>
      )}
      {log.response && (
        <div>
          <div className="text-green-400 mb-0.5">RESPONSE:</div>
          <pre className="text-gray-300 whitespace-pre-wrap text-[10px]">
            {log.response}
          </pre>
        </div>
      )}
      {log.error && (
        <div>
          <div className="text-red-400 mb-0.5">ERROR:</div>
          <pre className="text-red-300 whitespace-pre-wrap text-[10px]">
            {log.error}
          </pre>
        </div>
      )}
    </div>
  </div>
);

// ============================================
// MAIN APP
// ============================================

// Default API key for internal use
const DEFAULT_API_KEY =
  "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";

// Author ID to display name mapping (for Format B data)
// Update this mapping for your team members
const AUTHOR_ID_MAP = {
  "fb039a13-dab3-4163-bacd-c851e979ab78": "Sara Du",
  "a2c8c892-a8c8-4c9c-b207-d25c7917ad0a": "Ryan Haraki",
  "495409f5-40a8-40aa-8df5-32b9ea2e6d5e": "Jordan Ramos",
  "091244bf-fd4a-47d4-b1d8-ea00a88aae64": "Peter",
  "ffa63e81-2ec3-4649-b500-75642fd6d5cf": "Oli",
};

// Conversation ID to channel name mapping (for Format B data)
const CONVERSATION_NAME_MAP = {
  "50c671ac-2f1f-4357-8bc0-f6fafdb80d6c": "engineering",
};

// Available models
const AVAILABLE_MODELS = [
  {
    id: "claude-3-5-haiku-20241022",
    name: "Haiku 3.5",
    description: "Fast & cheap",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Sonnet 3.5",
    description: "Balanced",
  },
  { id: "claude-3-opus-20240229", name: "Opus 3", description: "Most capable" },
];

export default function StackGrouperPOC() {
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);
  const [selectedModel, setSelectedModel] = useState(
    "claude-3-5-haiku-20241022"
  );

  // Strategy configuration for LLM segmentation
  const [strategyConfig, setStrategyConfig] = useState({
    strategy: "hybrid", // 'segment-centric' | 'previous-centric' | 'hybrid'
    stalenessThreshold: 30, // minutes - segments older than this are less relevant
    maxSegmentsToShow: 5, // max segments to include in prompt
    preferPreviousMessage: true, // strongly weight previous message
  });

  const [jsonInput, setJsonInput] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);

  const [rawMessages, setRawMessages] = useState([]);
  const [atomicUnits, setAtomicUnits] = useState([]);
  const [validationBatches, setValidationBatches] = useState([]);
  const [validatedUnits, setValidatedUnits] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [stackFormationLog, setStackFormationLog] = useState([]);

  // LLM Segmentation state
  const [segmentationMode, setSegmentationMode] = useState("deterministic"); // 'deterministic' | 'llm'
  const [llmSegments, setLlmSegments] = useState([]);
  const [llmAnnotations, setLlmAnnotations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [viewMode, setViewMode] = useState("timeline"); // 'timeline' | 'cards'

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [error, setError] = useState("");
  const [expandedStackIndex, setExpandedStackIndex] = useState(null);

  const [showDebug, setShowDebug] = useState(true);
  const [debugLogs, setDebugLogs] = useState([]);
  const [showSingleMessageStacks, setShowSingleMessageStacks] = useState(true);
  const debugEndRef = useRef(null);

  const colorMap = useMemo(() => ({}), []);

  // Group messages by conversation for the timeline view
  const conversationGroups = useMemo(() => {
    const groups = new Map();

    // Sort messages chronologically first
    const sorted = [...rawMessages].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    sorted.forEach((msg) => {
      if (!groups.has(msg.conversation_id)) {
        groups.set(msg.conversation_id, {
          id: msg.conversation_id,
          name: msg.conversation_name || "DM",
          messages: [],
          participants: new Set(),
          isChannel:
            !!msg.conversation_name && msg.conversation_name.trim().length > 0,
        });
      }
      const group = groups.get(msg.conversation_id);
      group.messages.push(msg);
      group.participants.add(msg.author);
    });

    // Convert to array, convert participant Sets to arrays, sort by message count
    return Array.from(groups.values())
      .map((g) => ({ ...g, participants: Array.from(g.participants) }))
      .sort((a, b) => b.messages.length - a.messages.length);
  }, [rawMessages]);

  // Get annotation for a message
  const getAnnotationForMessage = (messageId) => {
    return llmAnnotations.find((a) => a.messageId === messageId);
  };

  // Get segment for a message
  const getSegmentForMessage = (messageId) => {
    const annotation = getAnnotationForMessage(messageId);
    if (!annotation) return null;
    return llmSegments.find((s) => s.id === annotation.segmentId);
  };

  // Get segment index (for letter: A, B, C...)
  const getSegmentIndex = (segmentId) => {
    return llmSegments.findIndex((s) => s.id === segmentId);
  };

  // Segment colors for visual distinction
  const segmentColors = [
    { border: "border-l-blue-500", bg: "bg-blue-50", text: "text-blue-700" },
    {
      border: "border-l-emerald-500",
      bg: "bg-emerald-50",
      text: "text-emerald-700",
    },
    {
      border: "border-l-purple-500",
      bg: "bg-purple-50",
      text: "text-purple-700",
    },
    { border: "border-l-amber-500", bg: "bg-amber-50", text: "text-amber-700" },
    { border: "border-l-rose-500", bg: "bg-rose-50", text: "text-rose-700" },
    { border: "border-l-cyan-500", bg: "bg-cyan-50", text: "text-cyan-700" },
    {
      border: "border-l-orange-500",
      bg: "bg-orange-50",
      text: "text-orange-700",
    },
    {
      border: "border-l-indigo-500",
      bg: "bg-indigo-50",
      text: "text-indigo-700",
    },
  ];

  const getSegmentColor = (segmentId) => {
    const index = getSegmentIndex(segmentId);
    return segmentColors[index % segmentColors.length];
  };

  const addDebugLog = (log) => {
    setDebugLogs((prev) => [
      ...prev,
      { ...log, timestamp: new Date().toISOString() },
    ]);
    // Removed auto-scroll to allow reading logs without being pulled to bottom
  };

  const updateLastDebugLog = (updates) => {
    setDebugLogs((prev) => {
      const updated = [...prev];
      if (updated.length > 0) {
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          ...updates,
        };
      }
      return updated;
    });
  };

  // Step 0 → 1
  // Step 0 → 1 (Deterministic mode)
  const handleProcessInput = () => {
    try {
      setError("");
      setDebugLogs([]);
      const data = JSON.parse(jsonInput);
      if (!Array.isArray(data)) throw new Error("JSON must be an array");

      // Detect format
      const sample = data[0];
      const isFormatA = !!sample?.workspace_event;
      const isFormatB = !!sample?.markdown_content && !!sample?.author_id;
      const formatName = isFormatA
        ? "A (nested workspace_event)"
        : isFormatB
        ? "B (flat message array)"
        : "Unknown";

      addDebugLog({
        title: "Data Format Detection",
        request: `Analyzing ${data.length} items...`,
        response: `Detected format: ${formatName}\nSample keys: ${Object.keys(
          sample
        ).join(", ")}`,
      });

      const messages = extractMessages(data);
      if (messages.length === 0)
        throw new Error(
          "No valid messages found (all filtered out - check for empty content)"
        );

      setRawMessages(messages);

      // Reset LLM segmentation state
      setLlmSegments([]);
      setLlmAnnotations([]);

      if (segmentationMode === "deterministic") {
        const units = createAtomicUnits(messages);
        setAtomicUnits(units);

        addDebugLog({
          title: "Step 1: Building Blocks",
          request: `Extracted ${messages.length} messages`,
          response: `Created ${units.length} groups using rules:\n• Same thread → extend\n• Same author + <2min → extend\n• Same conv + <1min → extend\n• Continuation signal + <3min → extend\n• Reply-like messages (async) + <24hr → extend`,
        });
      } else {
        // LLM mode - just extract messages, segmentation happens on button click
        addDebugLog({
          title: "Step 1: LLM Segmentation",
          request: `Extracted ${messages.length} messages`,
          response: `Ready for LLM-based segmentation. Click "Run LLM Segmentation" to process.`,
        });
      }

      setMaxStep(1);
      setCurrentStep(1);
    } catch (err) {
      setError(err.message);
    }
  };

  // Step 1: LLM Segmentation (async)
  const handleLLMSegmentation = async () => {
    if (!apiKey) {
      setError("Please enter your Anthropic API key");
      return;
    }

    if (rawMessages.length === 0) {
      setError("No messages to process");
      return;
    }

    setLoading(true);
    setError("");
    setLlmSegments([]);
    setLlmAnnotations([]);

    try {
      const result = await segmentMessages(
        rawMessages,
        apiKey,
        selectedModel,
        strategyConfig,
        (current, total, label) => {
          setProgress({ current, total, label });
        },
        addDebugLog
      );

      setLlmSegments(result.segments);
      setLlmAnnotations(result.annotations);

      addDebugLog({
        title: "Step 1: LLM Segmentation Complete",
        response:
          `${rawMessages.length} messages → ${result.segments.length} segments\n` +
          `Structural: ${
            result.annotations.filter((a) => a.method === "STRUCTURAL").length
          }\n` +
          `LLM: ${result.annotations.filter((a) => a.method === "LLM").length}`,
      });

      // In LLM mode, Step 1 is the final step (no need for Steps 2 & 3)
      setMaxStep(1);
    } catch (err) {
      setError(err.message);
      addDebugLog({ title: "LLM Segmentation Error", error: err.message });
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0, label: "" });
    }
  };

  // Single Prompt Segmentation - one call with all messages
  const handleSinglePromptSegmentation = async () => {
    if (!apiKey) {
      setError("Please enter your Anthropic API key");
      return;
    }

    if (rawMessages.length === 0) {
      setError("No messages to process");
      return;
    }

    setLoading(true);
    setError("");
    setLlmSegments([]);
    setLlmAnnotations([]);

    const systemPrompt = `You are given a list of messages from an Ando workspace in JSON format. Each message is an event with text content and metadata (such as timestamp, author, channel, thread id, or any other fields provided). Your task is to group these messages into semantically related groups called "stacks." Each stack represents a SPECIFIC topic, task, question, or issue being discussed.

CRITICAL: Output ONLY valid JSON. No markdown code blocks, no explanatory text, no \`\`\` markers. Start your response with { and end with }.

GRANULARITY IS KEY - PREFER SMALLER, FOCUSED STACKS:
- Each stack should be about ONE SPECIFIC ISSUE, not a broad category
- A stack like "General Development Discussion" is TOO BROAD - break it into specific issues
- "PR #423 Review" is a good stack. "Code Reviews" is too broad.
- "Fixing inbox loading error" is a good stack. "Bug fixes" is too broad.
- Different PRs = different stacks. Different bugs = different stacks.
- Questions and their answers can be one stack, but a new question = new stack
- Expect roughly 1 stack per 3-8 messages on average (a channel with 100 messages might have 15-40 stacks)
- Brief reactions/acknowledgments ("nice", "thanks", "lol") belong with the message they're reacting to

WHEN TO SPLIT INTO SEPARATE STACKS:
- Different PRs, issues, or bugs being discussed
- Different questions being asked
- Different announcements or updates
- Unrelated tangents that emerge in conversation
- Messages separated by significant time gaps discussing different things

Output structure:
{ "stacks": [ { "title": string, "summary": string, "message_ids": [ list of message id values ] }, ... ] }

NOTE: Do NOT include the full "messages" array - only include "message_ids" to keep the response compact.

Rules:
1. Semantic coherence: Messages in the same stack must be about the SAME SPECIFIC issue/topic.
2. Granular stacks: Prefer many small focused stacks over few large broad ones.
3. Minimal overlap: A message belongs in only one stack. Do not duplicate.
4. Distinct topics: Different tasks/issues/PRs/questions = different stacks.
5. Human readable: Titles should be specific and descriptive (not generic categories).
6. Complete coverage: Include every message in the input. Do not drop any.

Use the field "id" to reference each message in message_ids.`;

    try {
      console.log(
        "[Single Prompt] Starting with",
        rawMessages.length,
        "messages"
      );

      addDebugLog({
        title: "Single Prompt: Sending request",
        system: systemPrompt.slice(0, 500) + "...",
        request: `Sending ${rawMessages.length} messages to LLM`,
        response: "(waiting...)",
      });

      setProgress({ current: 1, total: 2, label: "Sending to LLM..." });

      // Format messages as JSON for the prompt
      const messagesJson = JSON.stringify(rawMessages, null, 2);
      const userMessage = `Here are the messages to group into stacks:\n\n${messagesJson}`;

      console.log(
        "[Single Prompt] User message length:",
        userMessage.length,
        "chars"
      );

      // Calculate max tokens based on message count (rough estimate: ~100 tokens per message for response)
      const estimatedMaxTokens = Math.min(
        Math.max(4000, rawMessages.length * 150),
        64000
      );

      console.log(
        "[Single Prompt] Calling API with max tokens:",
        estimatedMaxTokens
      );

      // Use longer timeout for single-prompt (5 minutes) since it processes all messages at once
      const response = await callAnthropic(
        apiKey,
        systemPrompt,
        userMessage,
        estimatedMaxTokens,
        selectedModel,
        300000 // 5 minute timeout
      );

      console.log(
        "[Single Prompt] Got response, length:",
        response?.length,
        "chars"
      );
      setProgress({ current: 2, total: 2, label: "Parsing response..." });

      // Parse the response JSON
      let parsedResponse;
      try {
        // First, strip markdown code blocks if present (```json ... ``` or ``` ... ```)
        let cleanedResponse = response;
        const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          cleanedResponse = codeBlockMatch[1].trim();
        }

        // Try to parse the cleaned response directly first
        try {
          parsedResponse = JSON.parse(cleanedResponse);
        } catch {
          // If that fails, try to extract JSON object from the text
          const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedResponse = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error("No JSON found in response");
          }
        }
      } catch (parseErr) {
        throw new Error(
          `Failed to parse LLM response: ${
            parseErr.message
          }\n\nResponse: ${response.slice(0, 500)}...`
        );
      }

      if (!parsedResponse.stacks || !Array.isArray(parsedResponse.stacks)) {
        throw new Error("Response missing 'stacks' array");
      }

      // Transform stacks to segment/annotation format
      const segments = [];
      const annotations = [];

      parsedResponse.stacks.forEach((stack, stackIndex) => {
        const segmentId = crypto.randomUUID();

        // Get message objects for this stack
        const stackMessageIds = stack.message_ids || [];
        const stackMessages = stackMessageIds
          .map((id) => rawMessages.find((m) => m.id === id))
          .filter(Boolean);

        // Extract unique participants
        const participants = [...new Set(stackMessages.map((m) => m.author))];

        // Create segment
        segments.push({
          id: segmentId,
          summary: stack.summary || stack.title,
          title: stack.title,
          messages: stackMessages,
          messageIds: stackMessageIds,
          participants: participants,
          status: "ACTIVE",
        });

        // Create annotations for each message
        stackMessageIds.forEach((messageId) => {
          annotations.push({
            messageId: messageId,
            conversationId: rawMessages.find((m) => m.id === messageId)
              ?.conversation_id,
            attachesTo: null,
            segmentId: segmentId,
            role: "GROUPED",
            confidence: 1.0,
            method: "SINGLE_PROMPT",
            reasoning: `Grouped into stack: ${stack.title}`,
            annotatedAt: new Date(),
          });
        });
      });

      setLlmSegments(segments);
      setLlmAnnotations(annotations);

      addDebugLog({
        title: "Single Prompt: Complete",
        response:
          `${rawMessages.length} messages → ${segments.length} stacks\n` +
          parsedResponse.stacks
            .map((s, i) => `• ${s.title} (${s.message_ids?.length || 0} msgs)`)
            .join("\n"),
      });

      setMaxStep(1);
    } catch (err) {
      setError(err.message);
      addDebugLog({ title: "Single Prompt Error", error: err.message });
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0, label: "" });
    }
  };

  // Convert LLM segments directly to stacks (skip Step 2 for LLM flow)
  const handleLLMSegmentsToStacks = () => {
    if (llmSegments.length === 0) {
      setError("No segments to process");
      return;
    }

    // Convert segments directly to stacks - each segment becomes a stack
    const newStacks = llmSegments.map((segment) => ({
      id: segment.id,
      title: segment.summary?.slice(0, 50) || "Untitled",
      summary: segment.summary || "",
      messages: segment.messages.map((m) => ({ ...m, groupId: segment.id })),
    }));

    setStacks(newStacks);
    setValidatedUnits([]); // Clear since we're skipping Step 2

    addDebugLog({
      title: "LLM Segments → Stacks",
      response: `${llmSegments.length} segments converted directly to stacks (skipped Step 2)`,
    });

    setMaxStep(3);
    setCurrentStep(3);
  };

  // Step 1 → 2 (BATCHED WITH OVERLAP)
  const handleValidateUnits = async () => {
    if (!apiKey) {
      setError("Please enter your Anthropic API key");
      return;
    }

    setLoading(true);
    setError("");
    setValidationBatches([]);

    // Create overlapping batches
    const batches = [];
    const batchStarts = [];
    for (let i = 0; i < atomicUnits.length; i += BATCH_SIZE - BATCH_OVERLAP) {
      const batch = atomicUnits.slice(i, i + BATCH_SIZE);
      if (batch.length > 0) {
        batches.push(batch);
        batchStarts.push(i);
      }
    }

    setProgress({
      current: 0,
      total: batches.length + 1, // +1 for post-merge pass
      label: "Validating batches...",
    });

    try {
      // Process batches with overlap
      const batchResults = new Map(); // Map from original unit index to adjusted unit
      const allBatchResults = [];

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const batchStart = batchStarts[batchIdx];

        setProgress({
          current: batchIdx + 1,
          total: batches.length + 1,
          label: `Batch ${batchIdx + 1}/${batches.length} (overlapping)`,
        });

        const { system, userMessage } = buildValidationPrompt(
          batch,
          batchStart
        );

        addDebugLog({
          title: `Step 2: Semantic Regroup Batch ${batchIdx + 1}/${
            batches.length
          } (Groups ${batchStart + 1}-${batchStart + batch.length})`,
          system: system,
          request: userMessage,
          response: "(waiting...)",
        });

        const response = await callAnthropic(
          apiKey,
          system,
          userMessage,
          2000,
          selectedModel
        );
        updateLastDebugLog({ response });

        let result;
        try {
          result = parseJSONSafe(response);
        } catch (parseErr) {
          addDebugLog({
            title: `Batch ${batchIdx + 1} Parse Error`,
            error: parseErr.message,
          });
          // Skip this batch, keep original units
          batch.forEach((u, i) => {
            const origIdx = batchStart + i;
            if (!batchResults.has(origIdx)) {
              batchResults.set(origIdx, { ...u, originalIndex: origIdx });
            }
          });
          allBatchResults.push({
            batchIdx,
            batchStart,
            analysis: [],
            error: parseErr.message,
          });
          continue;
        }

        const adjustedBatch = applyBatchAdjustments(
          batch,
          result.analysis || [],
          batchStart
        );

        // Store results, preferring later batches for overlap regions
        adjustedBatch.forEach((unit, i) => {
          // Find which original units this adjusted unit came from
          const mergedFrom = unit.mergedFrom || [];
          if (mergedFrom.length > 0) {
            // This is a merged unit - store it for all original indices
            mergedFrom.forEach((origUnitNum) => {
              const origIdx = origUnitNum - 1;
              batchResults.set(origIdx, { ...unit, originalIndex: origIdx });
            });
          } else {
            // Single unit - map back to original index
            const origIdx = batchStart + i;
            if (origIdx < atomicUnits.length) {
              batchResults.set(origIdx, { ...unit, originalIndex: origIdx });
            }
          }
        });

        allBatchResults.push({
          batchIdx,
          batchStart,
          analysis: result.analysis || [],
          inputCount: batch.length,
          outputCount: adjustedBatch.length,
        });

        setValidationBatches([...allBatchResults]);

        // Small delay between batches
        if (batchIdx < batches.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Convert map to array, deduplicating merged units
      const seenUnits = new Set();
      let allAdjustedUnits = [];

      for (let i = 0; i < atomicUnits.length; i++) {
        const adjusted = batchResults.get(i);
        if (!adjusted) continue;

        // Check if this unit was already added (from a merge)
        const unitKey = adjusted.id || adjusted.originalIndex;
        if (seenUnits.has(unitKey)) continue;

        seenUnits.add(unitKey);
        allAdjustedUnits.push({
          ...adjusted,
          index: allAdjustedUnits.length,
        });
      }

      // Post-merge pass: Check adjacent units for cross-batch merges
      setProgress({
        current: batches.length + 1,
        total: batches.length + 1,
        label: "Post-merge pass (checking adjacent units)...",
      });

      allAdjustedUnits = await postMergeAdjacentUnits(
        allAdjustedUnits,
        apiKey,
        selectedModel,
        addDebugLog,
        updateLastDebugLog
      );

      // Reindex final units
      allAdjustedUnits = allAdjustedUnits.map((u, i) => ({
        ...u,
        index: i,
      }));

      setValidatedUnits(allAdjustedUnits);

      addDebugLog({
        title: "Step 2: Semantic Regroup Complete",
        response: `${atomicUnits.length} groups → ${allAdjustedUnits.length} regrouped`,
      });

      setMaxStep(2);
      setCurrentStep(2);
    } catch (err) {
      setError(err.message);
      addDebugLog({
        title: "Step 2: Semantic Regroup Error",
        error: err.message,
      });
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0, label: "" });
    }
  };

  // Step 2 → 3
  const handleFormStacks = async () => {
    if (!apiKey) {
      setError("Please enter your Anthropic API key");
      return;
    }

    setLoading(true);
    setError("");
    setStacks([]);
    setStackFormationLog([]);
    setCurrentStep(3);
    setMaxStep(3);

    setProgress({
      current: 0,
      total: validatedUnits.length,
      label: "Forming stacks...",
    });

    try {
      let currentStacks = [];
      const log = [];

      for (let i = 0; i < validatedUnits.length; i++) {
        const unit = validatedUnits[i];
        setProgress({
          current: i + 1,
          total: validatedUnits.length,
          label: `Unit ${i + 1}/${validatedUnits.length}`,
        });

        const { system, userMessage } = buildStackAssignmentPrompt(
          unit,
          currentStacks
        );

        addDebugLog({
          title: `Step 3: LLM Stack Formation - Group ${i + 1}`,
          system,
          request: userMessage,
          response: "(waiting...)",
        });

        const response = await callAnthropic(
          apiKey,
          system,
          userMessage,
          300,
          selectedModel
        );
        updateLastDebugLog({ response });

        let decision;
        try {
          decision = parseJSONSafe(response);
        } catch (parseErr) {
          // Default to create new
          decision = {
            action: "create",
            title: "Parse Error Stack",
            summary: parseErr.message.slice(0, 100),
          };
        }

        const logEntry = { unitIndex: i, unit, decision };

        // Tag messages with their source group ID (UUID)
        const taggedMessages = unit.messages.map((m) => ({
          ...m,
          groupId: unit.id,
        }));

        if (
          decision.action === "join" &&
          decision.stack_index &&
          decision.stack_index <= currentStacks.length
        ) {
          const stackIdx = decision.stack_index - 1;
          currentStacks[stackIdx] = {
            ...currentStacks[stackIdx],
            messages: [
              ...currentStacks[stackIdx].messages,
              ...taggedMessages,
            ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
            title: decision.title || currentStacks[stackIdx].title,
            summary: decision.summary || currentStacks[stackIdx].summary,
          };
          logEntry.action = `→ Stack ${decision.stack_index}`;
        } else {
          currentStacks.push({
            id: generateUUID(),
            title: decision.title || "Untitled",
            summary: decision.summary || "",
            messages: [...taggedMessages],
          });
          logEntry.action = `+ Stack ${currentStacks.length}`;
        }

        log.push(logEntry);
        setStackFormationLog([...log]);
        setStacks([...currentStacks]);

        await new Promise((r) => setTimeout(r, 50));
      }

      addDebugLog({
        title: "Step 3: LLM Stack Formation Complete",
        response: `${validatedUnits.length} groups → ${currentStacks.length} stacks`,
      });
    } catch (err) {
      setError(err.message);
      addDebugLog({
        title: "Step 3: LLM Stack Formation Error",
        error: err.message,
      });
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0, label: "" });
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white border-b px-4 py-2 flex items-center justify-between">
        <h1 className="font-semibold text-gray-800">Stack Grouper PoC</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
              className="rounded"
            />
            Debug
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white"
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.description})
              </option>
            ))}
          </select>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-api-key..."
            className="w-52 px-2 py-1 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
        </div>
      </div>

      <StepTabs
        currentStep={currentStep}
        setCurrentStep={setCurrentStep}
        maxStep={maxStep}
      />

      {/* Progress bar */}
      {progress.total > 0 && (
        <div className="px-4 py-2 bg-blue-50 border-b">
          <ProgressBar
            current={progress.current}
            total={progress.total}
            label={progress.label}
          />
        </div>
      )}

      {error && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-50 text-red-600 text-sm rounded border border-red-200">
          {error}
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex overflow-hidden">
        <div
          className={`flex-1 overflow-hidden flex flex-col ${
            showDebug ? "" : ""
          }`}
        >
          {/* STEP 0 */}
          {currentStep === 0 && (
            <div className="flex-1 p-4 flex flex-col">
              {/* Mode Toggle */}
              <div className="mb-4 p-3 bg-white rounded-lg border">
                <div className="text-sm font-medium text-gray-700 mb-2">
                  Segmentation Mode
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSegmentationMode("deterministic")}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      segmentationMode === "deterministic"
                        ? "bg-blue-500 text-white"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    <div className="font-medium">Deterministic</div>
                    <div className="text-[10px] opacity-80">
                      Rules-based grouping (fast)
                    </div>
                  </button>
                  <button
                    onClick={() => setSegmentationMode("llm")}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      segmentationMode === "llm"
                        ? "bg-purple-500 text-white"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    <div className="font-medium">LLM Segmentation</div>
                    <div className="text-[10px] opacity-80">
                      Per-message classification
                    </div>
                  </button>
                </div>
                {segmentationMode === "llm" && (
                  <div className="mt-2 text-[10px] text-purple-600 bg-purple-50 px-2 py-1 rounded">
                    LLM mode processes each message individually, classifying
                    its role (INITIATES, DEVELOPS, RESPONDS, RESOLVES, REACTS)
                    and determining which conversation segment it belongs to.
                  </div>
                )}
              </div>

              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder="Paste events JSON..."
                className="flex-1 px-3 py-2 text-sm font-mono border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 resize-none"
              />
              <button
                onClick={handleProcessInput}
                disabled={
                  !jsonInput.trim() || (segmentationMode === "llm" && !apiKey)
                }
                className="mt-3 self-start px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium"
              >
                Process → Step 1
              </button>
              {segmentationMode === "llm" && !apiKey && (
                <div className="mt-2 text-xs text-amber-600">
                  Note: LLM mode requires an API key (enter in header)
                </div>
              )}
            </div>
          )}

          {/* STEP 1 */}
          {currentStep === 1 && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Deterministic Mode */}
              {segmentationMode === "deterministic" && (
                <>
                  <div className="px-4 py-2 border-b bg-white flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">
                        Deterministic
                      </span>
                      <span className="text-sm text-gray-600">
                        {rawMessages.length} msgs → {atomicUnits.length} units
                      </span>
                    </div>
                    <button
                      onClick={handleValidateUnits}
                      disabled={loading || !apiKey}
                      className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded text-sm font-medium"
                    >
                      {loading ? "⟳ Validating..." : "Validate → Step 2"}
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    <div className="grid gap-2 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {atomicUnits.map((unit) => (
                        <UnitCard
                          key={unit.id}
                          unit={unit}
                          colorMap={colorMap}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* LLM Segmentation Mode */}
              {segmentationMode === "llm" && (
                <>
                  {/* Header bar */}
                  <div className="px-4 py-2 border-b bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded font-medium">
                          LLM Segmentation
                        </span>
                        <span className="text-sm text-gray-600">
                          {rawMessages.length} msgs
                          {llmSegments.length > 0 &&
                            ` → ${llmSegments.length} segments`}
                        </span>

                        {/* View mode toggle */}
                        {llmSegments.length > 0 && (
                          <div className="flex items-center gap-1 ml-4 bg-gray-100 rounded p-0.5">
                            <button
                              onClick={() => setViewMode("timeline")}
                              className={`px-2 py-1 text-xs rounded transition-colors ${
                                viewMode === "timeline"
                                  ? "bg-white text-gray-800 shadow-sm"
                                  : "text-gray-500 hover:text-gray-700"
                              }`}
                            >
                              Timeline
                            </button>
                            <button
                              onClick={() => setViewMode("cards")}
                              className={`px-2 py-1 text-xs rounded transition-colors ${
                                viewMode === "cards"
                                  ? "bg-white text-gray-800 shadow-sm"
                                  : "text-gray-500 hover:text-gray-700"
                              }`}
                            >
                              Cards
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={
                            strategyConfig.strategy === "single-prompt"
                              ? handleSinglePromptSegmentation
                              : handleLLMSegmentation
                          }
                          disabled={
                            loading || !apiKey || rawMessages.length === 0
                          }
                          className="px-3 py-1.5 bg-purple-500 hover:bg-purple-600 disabled:bg-gray-300 text-white rounded text-sm font-medium"
                        >
                          {loading
                            ? "⟳ Processing..."
                            : strategyConfig.strategy === "single-prompt"
                            ? "Run Single-Prompt"
                            : "Run LLM Segmentation"}
                        </button>
                        {llmSegments.length > 0 && !loading && (
                          <button
                            onClick={handleLLMSegmentsToStacks}
                            className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm font-medium"
                          >
                            Create Stacks → Step 3
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Strategy Configuration Panel */}
                    <StrategyConfigPanel
                      config={strategyConfig}
                      setConfig={setStrategyConfig}
                    />
                  </div>

                  {/* Content area */}
                  <div className="flex-1 flex overflow-hidden">
                    {/* Empty state */}
                    {llmSegments.length === 0 && !loading && (
                      <div className="flex-1 flex items-center justify-center text-gray-500">
                        <div className="text-center">
                          <div className="text-lg mb-2">Ready to process</div>
                          <div className="text-sm">
                            Click "
                            {strategyConfig.strategy === "single-prompt"
                              ? "Run Single-Prompt"
                              : "Run LLM Segmentation"}
                            " to classify {rawMessages.length} messages
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Timeline view (Slack-like) */}
                    {llmSegments.length > 0 && viewMode === "timeline" && (
                      <>
                        <ConversationSidebar
                          conversations={conversationGroups}
                          selectedId={
                            selectedConversationId || conversationGroups[0]?.id
                          }
                          onSelect={(id) => setSelectedConversationId(id)}
                          llmSegments={llmSegments}
                          llmAnnotations={llmAnnotations}
                        />
                        <MessageTimeline
                          conversation={conversationGroups.find(
                            (c) =>
                              c.id ===
                              (selectedConversationId ||
                                conversationGroups[0]?.id)
                          )}
                          llmSegments={llmSegments}
                          llmAnnotations={llmAnnotations}
                          getAnnotationForMessage={getAnnotationForMessage}
                          getSegmentForMessage={getSegmentForMessage}
                          getSegmentIndex={getSegmentIndex}
                          getSegmentColor={getSegmentColor}
                          colorMap={colorMap}
                        />
                      </>
                    )}

                    {/* Cards view (original) */}
                    {llmSegments.length > 0 && viewMode === "cards" && (
                      <div className="flex-1 overflow-y-auto p-4">
                        <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
                          {llmSegments.map((segment, index) => (
                            <SegmentCard
                              key={segment.id}
                              segment={segment}
                              index={index}
                              colorMap={colorMap}
                              annotations={llmAnnotations}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* STEP 2 */}
          {currentStep === 2 && (
            <div className="flex-1 flex overflow-hidden">
              <div className="w-1/2 border-r flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b bg-white">
                  <span className="text-sm font-medium">Analysis</span>
                  <span className="text-xs text-gray-500 ml-2">
                    ({validationBatches.length} batches)
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {validationBatches.map((batch, i) => (
                    <div key={i} className="border rounded bg-white p-2">
                      <div className="text-xs font-medium text-gray-600 mb-1">
                        Batch {i + 1}: Units {batch.batchStart + 1}-
                        {batch.batchStart + batch.inputCount} →{" "}
                        {batch.outputCount} units
                      </div>
                      {batch.error && (
                        <div className="text-xs text-red-500">
                          {batch.error}
                        </div>
                      )}
                      <div className="space-y-1">
                        {batch.analysis?.map((item, j) => (
                          <div
                            key={j}
                            className={`text-xs px-2 py-1 rounded ${
                              item.action === "keep"
                                ? "bg-green-50 text-green-700"
                                : item.action === "split"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            <span className="font-mono">
                              {typeof item.unit === "string"
                                ? item.unit.slice(0, 6)
                                : item.unit}
                            </span>
                            : {item.action} {item.reason && `- ${item.reason}`}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="w-1/2 flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b bg-white flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Validated ({validatedUnits.length})
                  </span>
                  <button
                    onClick={handleFormStacks}
                    disabled={loading || !apiKey}
                    className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded text-sm font-medium"
                  >
                    {loading ? "⟳ Processing..." : "Form Stacks → Step 3"}
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-3">
                  <div className="grid gap-2 grid-cols-2">
                    {validatedUnits.map((unit) => (
                      <UnitCard
                        key={unit.id}
                        unit={unit}
                        colorMap={colorMap}
                        badge={
                          unit.mergedFrom
                            ? {
                                text: `merged ${unit.mergedFrom.join("+")}`,
                                color: "bg-blue-100 text-blue-700",
                              }
                            : unit.splitFrom
                            ? {
                                text: `split from ${unit.splitFrom}`,
                                color: "bg-amber-100 text-amber-700",
                              }
                            : null
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3 */}
          {currentStep === 3 && (
            <div className="flex-1 flex overflow-hidden">
              <div className="w-1/2 border-r flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b bg-white">
                  <span className="text-sm font-medium">Formation Log</span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-1">
                  {stackFormationLog.map((entry, i) => (
                    <div
                      key={i}
                      className={`text-xs p-2 rounded border ${
                        entry.action.startsWith("+")
                          ? "bg-green-50 border-green-200"
                          : "bg-blue-50 border-blue-200"
                      }`}
                    >
                      <div className="flex justify-between mb-1">
                        <span
                          className="font-medium font-mono"
                          title={entry.unit?.id}
                        >
                          {entry.unit?.id?.slice(0, 6) || "??????"}
                        </span>
                        <span
                          className={
                            entry.action.startsWith("+")
                              ? "text-green-600"
                              : "text-blue-600"
                          }
                        >
                          {entry.action}
                        </span>
                      </div>
                      <div className="text-gray-500 truncate">
                        {entry.unit.messages[0]?.content}
                      </div>
                      <div className="text-gray-400 mt-1">
                        → {entry.decision.title}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="w-1/2 flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b bg-white flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Stacks (
                    {
                      stacks.filter(
                        (s) => showSingleMessageStacks || s.messages.length > 1
                      ).length
                    }
                    )
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={showSingleMessageStacks}
                      onChange={(e) =>
                        setShowSingleMessageStacks(e.target.checked)
                      }
                      className="rounded"
                    />
                    Show single message stacks
                  </label>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {stacks
                    .filter(
                      (stack) =>
                        showSingleMessageStacks || stack.messages.length > 1
                    )
                    .map((stack, i) => (
                      <StackCard
                        key={stack.id}
                        stack={stack}
                        index={i}
                        colorMap={colorMap}
                        expanded={expandedStackIndex === i}
                        onToggle={() =>
                          setExpandedStackIndex(
                            expandedStackIndex === i ? null : i
                          )
                        }
                      />
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Debug Panel - Collapsible */}
        {showDebug && (
          <div
            className={`border-l bg-gray-900 flex flex-col overflow-hidden transition-all duration-200 ${
              debugLogs.length > 0 ? "w-96" : "w-12"
            }`}
          >
            <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between gap-2">
              {debugLogs.length > 0 ? (
                <>
                  <span className="text-sm font-medium text-gray-200 whitespace-nowrap">
                    Debug ({debugLogs.length})
                  </span>
                  <button
                    onClick={() => setDebugLogs([])}
                    className="text-xs text-gray-400 hover:text-gray-200"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <span
                  className="text-xs text-gray-500 writing-mode-vertical"
                  style={{ writingMode: "vertical-rl" }}
                >
                  Debug
                </span>
              )}
            </div>
            {debugLogs.length > 0 && (
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {debugLogs.map((log, i) => (
                  <DebugLog key={i} log={log} />
                ))}
                <div ref={debugEndRef} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
