---
name: configure-thread-destinations
description: Add thread/topic-aware destinations so agents can send to specific topics within a supergroup (e.g. Telegram forum topics, Discord threads).
---

# Configure Thread-Aware Destinations

Lets agents send messages to a specific thread or topic within a messaging group, instead of always posting to the default topic.

## When to use

Run this when you want an agent to post to a specific topic (e.g., an alerts topic, a logs topic) within a Telegram forum supergroup or a threaded Discord channel.

## How it works

The `agent_destinations` table gains an optional `thread_id` column. When set, the agent's outbound messages route to that specific thread instead of the channel default. The value is the adapter's encoded thread-id string.

**Telegram forum topics:** `telegram:<chatId>:<topicId>` (e.g., `telegram:-1001234567890:42`)
**Discord threads:** the adapter's thread-id string (varies by adapter version)

The delivery layer already passes `thread_id` through to the adapter — no changes needed there.

## Prerequisites

- NanoClaw v2.0.48+ (agent-destinations module installed)
- A messaging group wired to the agent (the supergroup/channel)
- The thread/topic ID you want to target

## Setup

### 1. Verify the migration

Check that the `thread_id` column exists on `agent_destinations`:

```bash
ncl destinations list --json | head -1
```

If the output includes `"thread_id": null` or `"thread_id": "..."`, the migration has been applied. If you get a schema error, the feature branch hasn't been merged yet — merge it first.

### 2. Find the topic ID

**Telegram:**
- Open the topic in Telegram
- The URL contains the topic ID: `https://t.me/c/<shortId>/<topicId>`
- The encoded thread-id is `telegram:<chatId>:<topicId>` where `<chatId>` is the numeric chat ID (including the `-100` prefix for supergroups)

**Discord:**
- Right-click the thread → Copy ID
- Check your channel adapter docs for the exact encoded format

### 3. Add the thread-aware destination

```bash
ncl destinations add \
  --agent-group-id <agent-group-id> \
  --local-name <topic-name> \
  --target-type channel \
  --target-id <messaging-group-id> \
  --thread-id telegram:<chatId>:<topicId>
```

This requires admin approval if the agent requests it from inside a container.

### 4. Restart the container

The destination projection is refreshed on every container wake, but a restart ensures the agent sees the new destination immediately:

```bash
ncl groups restart --id <agent-group-id>
```

### 5. Tell the agent to use the destination

The agent can now address messages to the topic by name:

```
<message to="alerts-topic">Weather alert: heavy rain expected at 3 PM.</message>
```

Or via the `send_message` MCP tool with `to: "alerts-topic"`.

## Removing a thread-aware destination

```bash
ncl destinations remove --agent-group-id <agent-group-id> --local-name <topic-name>
```

## Troubleshooting

- **Messages still land in General:** Verify the `thread_id` value matches the adapter's encoded format. For Telegram, it must be `telegram:<chatId>:<topicId>` (not just the topic number).
- **"Unknown destination" error:** The container hasn't picked up the new destination yet. Run `ncl groups restart` or wait for the next container wake.
- **Column doesn't exist error:** The migration hasn't been applied. Ensure the feature branch is merged and the host has been restarted.
