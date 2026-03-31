import { registerTool, ok, err } from './registry.js'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

function getNotionConfig(): { apiKey: string; dbId: string } | null {
  const apiKey = process.env.NOTION_API_KEY
  const dbId = process.env.DUCK_NOTION_TASKS_DB
  if (!apiKey || !dbId) return null
  return { apiKey, dbId }
}

// ─── notion_tasks: list / query tasks ────────────────────────────────────────

registerTool({
  definition: {
    name: 'notion_tasks',
    description:
      'Query the DuckCode Tasks database in Notion. ' +
      'Returns task name, status, priority, and agent status. ' +
      'Requires NOTION_API_KEY and DUCK_NOTION_TASKS_DB env vars.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description:
            'Filter by status: "Not started", "In progress", "Done" (optional)',
        },
        priority: {
          type: 'string',
          description: 'Filter by priority: "P0", "P1", "P2", "P3" (optional)',
        },
      },
    },
  },
  permission: 'auto',

  async execute(input) {
    const config = getNotionConfig()
    if (!config) {
      return err(
        'Notion not configured. Set NOTION_API_KEY and DUCK_NOTION_TASKS_DB env vars.',
      )
    }

    const filter: Record<string, unknown>[] = []

    if (input.status) {
      filter.push({
        property: 'Status',
        status: { equals: input.status as string },
      })
    }
    if (input.priority) {
      filter.push({
        property: 'Priority',
        select: { equals: input.priority as string },
      })
    }

    const body: Record<string, unknown> = {
      page_size: 50,
      sorts: [{ property: 'Status', direction: 'ascending' }],
    }
    if (filter.length === 1) {
      body.filter = filter[0]
    } else if (filter.length > 1) {
      body.filter = { and: filter }
    }

    try {
      const res = await fetch(`${NOTION_API}/databases/${config.dbId}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        return err(`Notion API ${res.status}: ${text.slice(0, 300)}`)
      }

      const data = (await res.json()) as {
        results: Array<{
          properties: Record<string, unknown>
          url: string
        }>
      }

      if (data.results.length === 0) {
        return ok('No tasks found matching the filter.')
      }

      const lines = data.results.map((page) => {
        const p = page.properties as Record<string, Record<string, unknown>>
        const name = extractTitle(p['Task name'])
        const status = extractStatus(p['Status'])
        const priority = extractSelect(p['Priority'])
        const agentStatus = extractText(p['Agent status'])
        const blocked = extractCheckbox(p['Agent blocked'])

        let line = `[${status}] ${name}`
        if (priority) line += ` (${priority})`
        if (blocked) line += ' ⛔ BLOCKED'
        if (agentStatus) line += ` — ${agentStatus}`
        return line
      })

      return ok(lines.join('\n'))
    } catch (e: unknown) {
      return err((e as Error).message)
    }
  },
})

// ─── notion_task_update: update a task's status/agent_status ─────────────────

registerTool({
  definition: {
    name: 'notion_task_update',
    description:
      'Update a task in the DuckCode Tasks Notion database. ' +
      'Use notion_tasks first to find task names, then update by name.',
    input_schema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Exact task name to find and update',
        },
        status: {
          type: 'string',
          description:
            'New status: "Not started", "In progress", "Done" (optional)',
        },
        agent_status: {
          type: 'string',
          description: 'Free-text agent status note (optional)',
        },
      },
      required: ['task_name'],
    },
  },
  permission: 'confirm',

  async execute(input) {
    const config = getNotionConfig()
    if (!config) {
      return err(
        'Notion not configured. Set NOTION_API_KEY and DUCK_NOTION_TASKS_DB env vars.',
      )
    }

    const taskName = input.task_name as string

    // Find the page by title
    const searchRes = await fetch(
      `${NOTION_API}/databases/${config.dbId}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: {
            property: 'Task name',
            title: { equals: taskName },
          },
          page_size: 1,
        }),
      },
    )

    if (!searchRes.ok) {
      return err(`Notion API ${searchRes.status}: ${(await searchRes.text()).slice(0, 300)}`)
    }

    const searchData = (await searchRes.json()) as {
      results: Array<{ id: string }>
    }
    if (searchData.results.length === 0) {
      return err(`Task not found: "${taskName}"`)
    }

    const pageId = searchData.results[0].id

    // Build update properties
    const properties: Record<string, unknown> = {}
    if (input.status) {
      properties['Status'] = { status: { name: input.status as string } }
    }
    if (input.agent_status !== undefined) {
      properties['Agent status'] = {
        rich_text: [{ text: { content: input.agent_status as string } }],
      }
    }

    if (Object.keys(properties).length === 0) {
      return err('Nothing to update. Provide status or agent_status.')
    }

    const updateRes = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    })

    if (!updateRes.ok) {
      return err(`Notion API ${updateRes.status}: ${(await updateRes.text()).slice(0, 300)}`)
    }

    return ok(`Updated "${taskName}": ${JSON.stringify(input)}`)
  },
})

// ─── Property extractors ────────────────────────────────────────────────────

function extractTitle(prop: Record<string, unknown> | undefined): string {
  if (!prop) return '(untitled)'
  const arr = prop.title as Array<{ plain_text: string }> | undefined
  return arr?.[0]?.plain_text ?? '(untitled)'
}

function extractStatus(prop: Record<string, unknown> | undefined): string {
  if (!prop) return '?'
  const s = prop.status as { name: string } | undefined
  return s?.name ?? '?'
}

function extractSelect(prop: Record<string, unknown> | undefined): string {
  if (!prop) return ''
  const s = prop.select as { name: string } | null | undefined
  return s?.name ?? ''
}

function extractText(prop: Record<string, unknown> | undefined): string {
  if (!prop) return ''
  const arr = prop.rich_text as Array<{ plain_text: string }> | undefined
  return arr?.map((t) => t.plain_text).join('') ?? ''
}

function extractCheckbox(prop: Record<string, unknown> | undefined): boolean {
  if (!prop) return false
  return (prop.checkbox as boolean) ?? false
}
