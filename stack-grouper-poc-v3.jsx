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
// LEVEL 1: DETERMINISTIC ATOMIC UNITS
// ============================================

const extractMessages = (data) => {
  return data
    .map((item) => {
      const msg = item?.workspace_event?.message || {};
      const actor = item?.workspace_event?.actor_member || {};
      const conv = item?.workspace_event?.conversation || {};
      return {
        id: item.id,
        created_at: msg.created_at || "",
        content: msg.markdown_content || "",
        author: actor.display_name || "Unknown",
        conversation_id: item?.workspace_event?.conversation_id || "",
        conversation_name: conv.name || "",
        thread_id: item?.workspace_event?.thread_root_id || null,
      };
    })
    .filter((m) => m.id && m.created_at);
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

const callAnthropic = async (apiKey, system, userMessage, maxTokens = 2000) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

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
  addDebugLog,
  updateLastDebugLog
) => {
  if (units.length <= 1) return units;

  addDebugLog({
    title: "L1.5 Post-Merge Pass",
    request: `Checking ${units.length} units for adjacent merges...`,
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
      const response = await callAnthropic(apiKey, system, userMessage, 1000);
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
    { id: 1, label: "L1: Atomic" },
    { id: 2, label: "L1.5: Validated" },
    { id: 3, label: "L2: Stacks" },
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

const MessageBubble = ({ message, colorMap, compact = false }) => {
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
        <div className="flex items-baseline gap-2">
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
        </div>
        <p
          className={`${
            compact ? "text-xs" : "text-sm"
          } text-gray-700 break-words`}
        >
          {message.content || (
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

  return (
    <div
      className={`p-2 rounded-lg border ${
        highlight ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-400">
            U{unit.index + 1}
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

const StackCard = ({ stack, index, colorMap, expanded, onToggle }) => (
  <div className="border rounded-lg bg-white overflow-hidden">
    <div
      onClick={onToggle}
      className="p-3 cursor-pointer hover:bg-gray-50 flex items-start justify-between gap-2"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono text-gray-400">S{index + 1}</span>
          <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
            {stack.messages.length}
          </span>
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
          <MessageBubble key={m.id} message={m} colorMap={colorMap} compact />
        ))}
      </div>
    )}
  </div>
);

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

export default function StackGrouperPOC() {
  const [apiKey, setApiKey] = useState("");
  const [jsonInput, setJsonInput] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);

  const [rawMessages, setRawMessages] = useState([]);
  const [atomicUnits, setAtomicUnits] = useState([]);
  const [validationBatches, setValidationBatches] = useState([]);
  const [validatedUnits, setValidatedUnits] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [stackFormationLog, setStackFormationLog] = useState([]);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [error, setError] = useState("");
  const [expandedStackIndex, setExpandedStackIndex] = useState(null);

  const [showDebug, setShowDebug] = useState(true);
  const [debugLogs, setDebugLogs] = useState([]);
  const debugEndRef = useRef(null);

  const colorMap = useMemo(() => ({}), []);

  const addDebugLog = (log) => {
    setDebugLogs((prev) => [
      ...prev,
      { ...log, timestamp: new Date().toISOString() },
    ]);
    setTimeout(
      () => debugEndRef.current?.scrollIntoView({ behavior: "smooth" }),
      100
    );
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
  const handleProcessInput = () => {
    try {
      setError("");
      setDebugLogs([]);
      const data = JSON.parse(jsonInput);
      if (!Array.isArray(data)) throw new Error("JSON must be an array");

      const messages = extractMessages(data);
      if (messages.length === 0) throw new Error("No valid messages found");

      setRawMessages(messages);
      const units = createAtomicUnits(messages);
      setAtomicUnits(units);

      addDebugLog({
        title: "L1: Atomic Units",
        request: `Extracted ${messages.length} messages`,
        response: `Created ${units.length} atomic units using rules:\n• Same thread → extend\n• Same author + <2min → extend\n• Same conv + <1min → extend\n• Continuation signal + <3min → extend\n• Reply-like messages (async) + <24hr → extend`,
      });

      setMaxStep(1);
      setCurrentStep(1);
    } catch (err) {
      setError(err.message);
    }
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
          title: `L1.5 Batch ${batchIdx + 1}/${batches.length} (Units ${
            batchStart + 1
          }-${batchStart + batch.length})`,
          system: system,
          request: userMessage,
          response: "(waiting...)",
        });

        const response = await callAnthropic(apiKey, system, userMessage, 2000);
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
        title: "L1.5 Complete",
        response: `${atomicUnits.length} units → ${allAdjustedUnits.length} validated units`,
      });

      setMaxStep(2);
      setCurrentStep(2);
    } catch (err) {
      setError(err.message);
      addDebugLog({ title: "L1.5 Error", error: err.message });
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
          title: `L2: Unit ${i + 1}`,
          system,
          request: userMessage,
          response: "(waiting...)",
        });

        const response = await callAnthropic(apiKey, system, userMessage, 300);
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
              ...unit.messages,
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
            messages: [...unit.messages],
          });
          logEntry.action = `+ Stack ${currentStacks.length}`;
        }

        log.push(logEntry);
        setStackFormationLog([...log]);
        setStacks([...currentStacks]);

        await new Promise((r) => setTimeout(r, 50));
      }

      addDebugLog({
        title: "L2 Complete",
        response: `${validatedUnits.length} units → ${currentStacks.length} stacks`,
      });
    } catch (err) {
      setError(err.message);
      addDebugLog({ title: "L2 Error", error: err.message });
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
              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder="Paste events JSON..."
                className="flex-1 px-3 py-2 text-sm font-mono border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 resize-none"
              />
              <button
                onClick={handleProcessInput}
                disabled={!jsonInput.trim()}
                className="mt-3 self-start px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium"
              >
                Process → L1
              </button>
            </div>
          )}

          {/* STEP 1 */}
          {currentStep === 1 && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-4 py-2 border-b bg-white flex items-center justify-between">
                <span className="text-sm text-gray-600">
                  {rawMessages.length} msgs → {atomicUnits.length} units
                </span>
                <button
                  onClick={handleValidateUnits}
                  disabled={loading || !apiKey}
                  className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded text-sm font-medium"
                >
                  {loading ? "⟳ Validating..." : "Validate → L1.5"}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <div className="grid gap-2 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {atomicUnits.map((unit) => (
                    <UnitCard key={unit.id} unit={unit} colorMap={colorMap} />
                  ))}
                </div>
              </div>
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
                            U{item.unit}: {item.action}{" "}
                            {item.reason && `- ${item.reason}`}
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
                    {loading ? "⟳ Processing..." : "Form Stacks → L2"}
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
                        <span className="font-medium">
                          U{entry.unitIndex + 1}
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
                <div className="px-4 py-2 border-b bg-white">
                  <span className="text-sm font-medium">
                    Stacks ({stacks.length})
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {stacks.map((stack, i) => (
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

        {/* Debug Panel */}
        {showDebug && (
          <div className="w-96 border-l bg-gray-900 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-200">
                Debug ({debugLogs.length})
              </span>
              <button
                onClick={() => setDebugLogs([])}
                className="text-xs text-gray-400 hover:text-gray-200"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {debugLogs.map((log, i) => (
                <DebugLog key={i} log={log} />
              ))}
              <div ref={debugEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
