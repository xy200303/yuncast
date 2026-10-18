import { Value } from 'typebox/value'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolCaller, ToolCtx, ToolDef, ToolRisk } from './types'
import { speechTools } from './speech'
import { draftTools } from './draft'
import { sceneTools } from './scene'
import { knowledgeTools } from './knowledge'
import { viewerTools } from './viewer'
import { connectorTools } from './connector'
import { webTools } from './web'
import { sessionTools } from './session'
import { agentTools } from './agent'
import { eventsTools } from './events'
import { programTools } from './program'
import { personaTools } from './persona'
import { voiceTools } from './voice'
import { triggerTools } from './trigger'
import { statsTools } from './stats'
import { recordTools } from './record'

/**
 * 工具目录：唯一事实源。内置 agent 的 function-calling、MCP 的 tools/list、CLI 的 schema
 * 全从这里生成。新增工具 = 往对应域文件里加一个 defineTool。
 */
export const ALL_TOOLS: ToolDef[] = [
  ...speechTools,
  ...draftTools,
  ...sceneTools,
  ...programTools,
  ...personaTools,
  ...voiceTools,
  ...triggerTools,
  ...knowledgeTools,
  ...viewerTools,
  ...connectorTools,
  ...webTools,
  ...sessionTools,
  ...statsTools,
  ...recordTools,
  ...agentTools,
  ...eventsTools
]

export function toolsForAgent(): ToolDef[] {
  return ALL_TOOLS.filter((tool) => tool.expose.agent)
}

export function toolsForMcp(): ToolDef[] {
  return ALL_TOOLS.filter((tool) => tool.expose.mcp)
}

export function findTool(name: string, caller: ToolCaller): ToolDef {
  const pool = caller === 'agent' ? toolsForAgent() : toolsForMcp()
  const tool = pool.find((item) => item.name === name)
  if (!tool) throw new Error(`未知工具: ${name}。先调 tools 看可用清单`)
  return tool
}

// ---------- 内置 agent 出口：包成 pi-agent-core 的 AgentTool ----------

export function toAgentTool(def: ToolDef, ctx: ToolCtx): AgentTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: async (_id: string, params: unknown) => {
      try {
        const text = await def.handler(ctx, params as never)
        return { content: [{ type: 'text' as const, text }], details: {} }
      } catch (error) {
        // 池/护栏错误如实告诉主播，让它换策略而不是崩溃
        return {
          content: [{ type: 'text' as const, text: `操作被拒绝：${error instanceof Error ? error.message : String(error)}` }],
          details: {}
        }
      }
    }
  } as AgentTool
}

export function buildAgentTools(ctx: ToolCtx): AgentTool[] {
  return toolsForAgent().map((def) => toAgentTool(def, ctx))
}

// ---------- MCP / CLI 出口：JSON Schema 直出（TypeBox schema 本身就是 JSON Schema） ----------

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint: true }
  risk: ToolRisk
}

export function mcpToolList(): McpToolInfo[] {
  return toolsForMcp().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as Record<string, unknown>,
    ...(tool.risk === 'read' ? { annotations: { readOnlyHint: true as const } } : {}),
    risk: tool.risk
  }))
}

function formatValueErrors(schema: ToolDef['parameters'], value: unknown): string | null {
  const errors = [...Value.Errors(schema, value)]
  if (errors.length === 0) return null
  return errors
    .slice(0, 5)
    .map((issue) => `${issue.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(根)'}: ${issue.message}`)
    .join('\n')
}

/** 外部入口统一调用：校验参数 → 跑 handler → 错误翻译成 actionable 文案 */
export async function callTool(ctx: ToolCtx, name: string, raw: Record<string, unknown>): Promise<string> {
  const tool = findTool(name, 'external')
  const bad = formatValueErrors(tool.parameters, raw ?? {})
  if (bad) throw new Error(`参数不对：\n${bad}\n先看 schema ${name} 确认参数`)
  try {
    return await tool.handler(ctx, (raw ?? {}) as never)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

/** CLI 的 tools/schema 文本 */
export function toolsText(): string {
  return JSON.stringify(
    toolsForMcp().map((tool) => ({ name: tool.name, description: tool.description })),
    null,
    2
  )
}

export function schemaText(name?: string): string {
  const list = name ? [findTool(name, 'external')] : toolsForMcp()
  return JSON.stringify(
    list.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters
    })),
    null,
    2
  )
}
