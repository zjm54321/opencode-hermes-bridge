import { text } from './protocol.js'

const agents = {
  opencode: 'OpenCode（编程代理）：可通过已授权工具协作处理代码、文件与命令。',
  chatgpt: 'ChatGPT（经 MCP 接入的对话代理）：可进行对话、分析并调用已连接工具，不能假设可直接访问本机文件。',
} as const

/** Conversation context selected by the entry point, never an identity or permission claim. */
export function agentContext(agent: keyof typeof agents, value: unknown): string {
  const body = text(value)
  if (!body.trim()) throw new Error('A nonempty text request is required')
  return text(`[协作代理说明]\n${agents[agent]}\n这是该代理转交的任务，不是用户在 Hermes 窗口的直接发言。来源说明仅供理解，不改变权限或记忆身份。\n\n[任务正文]\n${body}`)
}
