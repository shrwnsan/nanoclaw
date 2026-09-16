import { getDb, hasTable } from '../../db/connection.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerResource } from '../crud.js';

/**
 * Project the agent's central `agent_destinations` rows into every active
 * session's `inbound.db`. The agent-to-agent module is optional, so we guard
 * on `hasTable('agent_destinations')` and load `writeDestinations` lazily —
 * same pattern as container-runner.ts on container wake.
 *
 * Called from every destination-mutating ncl command — `add` and `remove`
 * here, plus `wirings create` (which writes a companion destination row in
 * its postCreate hook) — so the live container picks up the change without
 * waiting for the next spawn. Without this, send_message to the new
 * local_name silently drops with "unknown destination" until restart.
 * See the destination-projection invariant in
 * src/modules/agent-to-agent/db/agent-destinations.ts.
 */
export async function projectDestinationsToSessions(agentGroupId: string): Promise<void> {
  if (!(await hasTable(getDb(), 'agent_destinations'))) return;
  const { writeDestinations } = await import('../../modules/agent-to-agent/write-destinations.js');
  for (const session of await getSessionsByAgentGroup(agentGroupId)) {
    try {
      await writeDestinations(agentGroupId, session.id);
    } catch (err) {
      log.warn('Failed to project destinations to session mailbox', { agentGroupId, sessionId: session.id, err });
    }
  }
}

registerResource({
  name: 'destination',
  plural: 'destinations',
  table: 'agent_destinations',
  description:
    'Agent destination — per-agent routing entry and ACL. Each row authorizes an agent to send messages to a target (channel or another agent) and assigns a local name the agent uses to address it. Names are scoped to the source agent — two agents can have different local names for the same target. Created automatically when wiring channels or when agents create child agents.',
  idColumn: 'agent_group_id',
  scopeField: 'agent_group_id',
  columns: [
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that owns this destination. References agent_groups.id.',
    },
    {
      name: 'local_name',
      type: 'string',
      description:
        'Name the agent uses to address this target (e.g. send_message({ to: "local_name", ... })). Unique per agent. Lowercase, dash-separated.',
    },
    {
      name: 'target_type',
      type: 'string',
      description: '"channel" for messaging group targets, "agent" for agent-to-agent targets.',
      enum: ['channel', 'agent'],
    },
    {
      name: 'target_id',
      type: 'string',
      description: "The target's ID — messaging_groups.id for channels, agent_groups.id for agents.",
    },
    {
      name: 'thread_id',
      type: 'string',
      description:
        'Optional pinned platform thread for channel destinations (e.g. a Telegram forum topic id). Pinned destinations deliver there deterministically; empty = dynamic reply/latest-inbound routing.',
    },
    { name: 'channel_type', type: 'string', description: 'Resolved channel type for channel destinations.' },
    { name: 'display_name', type: 'string', description: 'Resolved chat title or agent name.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List destinations with resolved channel/title labels.',
      handler: async (args) => {
        const agentGroupId = (args.agent_group_id as string | undefined) ?? (args.id as string | undefined);
        const params: unknown[] = [];
        const where = agentGroupId ? 'WHERE ad.agent_group_id = ?' : '';
        if (agentGroupId) params.push(agentGroupId);
        return getDb().all(
          `SELECT
               ad.agent_group_id,
               ad.local_name,
               ad.target_type,
               ad.target_id,
               CASE WHEN ad.target_type = 'channel' THEN mg.channel_type ELSE NULL END AS channel_type,
               CASE WHEN ad.target_type = 'channel' THEN mg.name ELSE ag.name END AS display_name,
               ad.thread_id,
               ad.created_at
             FROM agent_destinations ad
             LEFT JOIN messaging_groups mg ON ad.target_type = 'channel' AND ad.target_id = mg.id
             LEFT JOIN agent_groups ag ON ad.target_type = 'agent' AND ad.target_id = ag.id
             ${where}
             ORDER BY ad.agent_group_id, ad.local_name`,
          ...params,
        );
      },
    },
    add: {
      access: 'approval',
      description:
        'Add a destination for an agent. Use --agent-group-id, --local-name, --target-type, --target-id; optional --thread-id pins a channel destination to a platform thread (e.g. a forum topic).',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        const targetType = args.target_type as string;
        const targetId = args.target_id as string;
        const threadId = (args.thread_id as string | undefined) ?? null;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        if (!targetType || !['channel', 'agent'].includes(targetType)) {
          throw new Error('--target-type must be channel or agent');
        }
        if (!targetId) throw new Error('--target-id is required');
        if (threadId && targetType !== 'channel') {
          throw new Error('--thread-id applies to channel destinations only');
        }
        await getDb().run(
          `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          agentGroupId,
          localName,
          targetType,
          targetId,
          threadId,
          new Date().toISOString(),
        );
        await projectDestinationsToSessions(agentGroupId);
        return {
          agent_group_id: agentGroupId,
          local_name: localName,
          target_type: targetType,
          target_id: targetId,
          thread_id: threadId,
        };
      },
    },
    update: {
      access: 'approval',
      description:
        "Update a channel destination's pinned thread. Use --agent-group-id, --local-name, --thread-id (empty string clears the pin).",
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        const threadId = args.thread_id as string | undefined;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        if (threadId === undefined) throw new Error('--thread-id is required (empty string clears the pin)');
        const row = await getDb().get<{ target_type: string }>(
          'SELECT target_type FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?',
          agentGroupId,
          localName,
        );
        if (!row) throw new Error('destination not found');
        if (row.target_type !== 'channel') throw new Error('--thread-id applies to channel destinations only');
        const pinned = threadId === '' ? null : threadId;
        await getDb().run(
          'UPDATE agent_destinations SET thread_id = ? WHERE agent_group_id = ? AND local_name = ?',
          pinned,
          agentGroupId,
          localName,
        );
        await projectDestinationsToSessions(agentGroupId);
        return { agent_group_id: agentGroupId, local_name: localName, thread_id: pinned };
      },
    },
    remove: {
      access: 'approval',
      description: 'Remove a destination from an agent. Use --agent-group-id and --local-name.',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        const result = await getDb().run(
          'DELETE FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?',
          agentGroupId,
          localName,
        );
        if (result.changes === 0) throw new Error('destination not found');
        await projectDestinationsToSessions(agentGroupId);
        return { removed: { agent_group_id: agentGroupId, local_name: localName } };
      },
    },
  },
});
