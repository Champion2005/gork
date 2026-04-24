import { OpenRouter } from '@openrouter/sdk'

const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')

export type UsageStats = { inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
type ChatOut = { content: string; usage: UsageStats }

const or = new OpenRouter({ apiKey })
const tools: any[] = []
const handlers: { [key: string]: (args: any) => any } = {}

const numberOrZero = (value: unknown): number => typeof value == 'number' && Number.isFinite(value) ? value : 0
const mergeUsage = (a: UsageStats, b: UsageStats): UsageStats => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
})

export const tool = (name: string, desc: string, params: string[], func: (args: any) => any) => {
    const parameters = { type: 'object', properties: Object.fromEntries(params.map(p => [p, { type: 'string' }])) }
    tools.push({ type: 'function', function: { name, description: desc, parameters } })
    handlers[name] = func
}

const buildMsgs = (args: (string | {msg: string, name: string} | {msg: string, name: string}[])[]): {role: 'system' | 'user' | 'assistant', content: string}[] => [
    {role: 'system', content: args[0] as string }, 
    {role: 'user', content: args.flat().filter(a => typeof a != 'string').map(a => `${a.name}: ${a.msg}`).join('\n')},
    ...args.slice(1).filter(a => typeof a == 'string').map(a => ({role: 'assistant', content: a} as const))
]

export const get = async (...msgs: (string | { msg: string; name: string } | { msg: string; name: string }[])[]): Promise<ChatOut> => {
    const msg = await or.chat.send({ chatRequest: { messages: buildMsgs(msgs), model: 'x-ai/grok-4.20', tools } })
    const usageFromChat: UsageStats = {
        inputTokens: numberOrZero(msg.usage?.promptTokens),
        outputTokens: numberOrZero(msg.usage?.completionTokens),
        cachedTokens: numberOrZero(msg.usage?.promptTokensDetails?.cachedTokens),
        cost: 0,
    }

    let usage: UsageStats = usageFromChat
    try {
        const generation = await or.generations.getGeneration({ id: msg.id })
        usage = {
            inputTokens: generation.data.tokensPrompt ?? usageFromChat.inputTokens,
            outputTokens: generation.data.tokensCompletion ?? usageFromChat.outputTokens,
            cachedTokens: generation.data.nativeTokensCached ?? usageFromChat.cachedTokens,
            cost: generation.data.totalCost ?? generation.data.usage ?? 0,
        }
    } catch (error) {
        console.error(`failed to fetch generation usage for ${msg.id}`, error)
    }

    const tool = msg.choices[0].message.toolCalls?.[0]?.function
    if (!tool) return { content: msg.choices[0].message.content, usage }

    const args = JSON.parse(tool.arguments)
    const out = await handlers[tool.name](args)
    msgs.push(`successfully called ${tool.name} ${JSON.stringify(args)}:\n${out}`)
    if (args.content) args.content = '<truncated>'
    console.log(`${tool.name} ${JSON.stringify(args)}: ${out?.length}`)
    const next = await get(...msgs)
    return { content: next.content, usage: mergeUsage(usage, next.usage) }
}

export const getText = async (...msgs: (string | { msg: string; name: string } | { msg: string; name: string }[])[]) =>
    (await get(...msgs)).content
