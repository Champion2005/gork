import { OpenRouter } from '@openrouter/sdk'

const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')

export type UsageStats = { inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
type ChatOut = { content: string; usage: UsageStats }
type ModelPricing = { prompt: number; completion: number; inputCacheRead: number }
type ChatLine = { msg: string; name: string; id?: string; role?: 'user' | 'assistant' }
type ChatInput = string | ChatLine | ChatLine[]

const or = new OpenRouter({ apiKey })
const tools: any[] = []
const handlers: { [key: string]: (args: any) => any } = {}
let pricingCache: Record<string, ModelPricing> | null = null

const numberOrZero = (value: unknown): number => typeof value == 'number' && Number.isFinite(value) ? value : 0
const pickNumber = (...values: unknown[]) => {
    for (const value of values) {
        if (typeof value == 'number' && Number.isFinite(value)) return value
    }
    return undefined
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const mergeUsage = (a: UsageStats, b: UsageStats): UsageStats => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
})

const parseModelPricing = (value: unknown): ModelPricing => {
    const raw = typeof value == 'object' && value !== null ? value as Record<string, unknown> : {}
    return {
        prompt: Number.parseFloat(String(raw.prompt ?? 0)) || 0,
        completion: Number.parseFloat(String(raw.completion ?? 0)) || 0,
        inputCacheRead: Number.parseFloat(String(raw.input_cache_read ?? 0)) || 0,
    }
}

const getPricingCache = async (): Promise<Record<string, ModelPricing>> => {
    if (pricingCache) return pricingCache
    const res = await fetch('https://openrouter.ai/api/v1/models')
    if (!res.ok) throw new Error(`failed to load model pricing: ${res.status}`)
    const payload = await res.json() as { data?: { id?: string; pricing?: unknown }[] }
    pricingCache = Object.fromEntries((payload.data ?? [])
        .map((row) => [row.id ?? '', parseModelPricing(row.pricing)] as const)
        .filter(([id]) => Boolean(id)))
    return pricingCache
}

const resolvePricingForModel = (index: Record<string, ModelPricing>, model: string): ModelPricing | undefined => {
    if (index[model]) return index[model]
    const fallbackId = Object.keys(index)
        .filter((id) => model.startsWith(`${id}-`))
        .sort((a, b) => b.length - a.length)[0]
    return fallbackId ? index[fallbackId] : undefined
}

const estimateCostFromPricing = async (model: string, usage: UsageStats): Promise<number> => {
    try {
        const pricing = resolvePricingForModel(await getPricingCache(), model)
        if (!pricing) return usage.cost

        const cached = Math.max(0, usage.cachedTokens)
        const prompt = Math.max(0, usage.inputTokens - cached)
        const completion = Math.max(0, usage.outputTokens)
        const cachePrice = pricing.inputCacheRead || pricing.prompt
        return prompt * pricing.prompt + cached * cachePrice + completion * pricing.completion
    } catch (error) {
        console.error('failed to estimate model cost', error)
        return usage.cost
    }
}

const readGenerationUsage = async (id: string, fallback: UsageStats): Promise<UsageStats> => {
    let lastError: unknown
    for (const waitMs of [0, 300, 1200]) {
        if (waitMs) await sleep(waitMs)
        try {
            const generation = await or.generations.getGeneration({ id })
            return {
                inputTokens: pickNumber(generation.data.tokensPrompt, fallback.inputTokens) ?? 0,
                outputTokens: pickNumber(generation.data.tokensCompletion, fallback.outputTokens) ?? 0,
                cachedTokens: pickNumber(generation.data.nativeTokensCached, fallback.cachedTokens) ?? 0,
                cost: pickNumber(generation.data.totalCost, generation.data.usage, fallback.cost) ?? 0,
            }
        } catch (error) {
            lastError = error
        }
    }
    const statusCode = typeof lastError == 'object' && lastError !== null && 'statusCode' in lastError
        ? Number((lastError as { statusCode?: unknown }).statusCode)
        : undefined
    if (statusCode != 404) console.error(`failed to fetch generation usage for ${id}`, lastError)
    return fallback
}

export const tool = (name: string, desc: string, params: string[], func: (args: any) => any) => {
    const parameters = { type: 'object', properties: Object.fromEntries(params.map(p => [p, { type: 'string' }])) }
    tools.push({ type: 'function', function: { name, description: desc, parameters } })
    handlers[name] = func
}

const buildMsgs = (args: ChatInput[]): { role: 'system' | 'user' | 'assistant' | 'tool', content: string, name?: string }[] => {
    const sys = args[0] as string
    const lines = args.flat().filter(a => typeof a != 'string') as ChatLine[]
    const assistantMsgs = args.slice(1).filter(a => typeof a == 'string') as string[]

    const messages: any[] = [
        { role: 'system', content: sys }
    ]

    // Add history + current message in a structured way
    lines.forEach((line, idx) => {
        const isLast = idx === lines.length - 1
        const role = line.role || (line.id === 'gork' ? 'assistant' : 'user')
        messages.push({
            role,
            name: line.name.replace(/[^a-zA-Z0-9_-]/g, '_'), // Tool names/names must match pattern
            content: isLast ? `[CURRENT MESSAGE from ${line.name} (ID: ${line.id})]: ${line.msg}` : `${line.name}: ${line.msg}`
        })
    })

    assistantMsgs.forEach(msg => {
        messages.push({ role: 'assistant', content: msg })
    })

    return messages
}

export const getWithOptions = async (options: { model?: string }, ...msgs: ChatInput[]): Promise<ChatOut> => {
    const initialModel = options.model?.trim() || 'x-ai/grok-4.20'
    let model = initialModel
    let lastError: any = null

    for (const attempt of [1, 2, 3]) {
        try {
            const msg = await or.chat.send({ chatRequest: { messages: buildMsgs(msgs), model, tools } })
            const usageObj = typeof msg.usage == 'object' && msg.usage !== null ? msg.usage as Record<string, unknown> : {}
            let usageFromChat: UsageStats = {
                inputTokens: numberOrZero(msg.usage?.promptTokens),
                outputTokens: numberOrZero(msg.usage?.completionTokens),
                cachedTokens: numberOrZero(msg.usage?.promptTokensDetails?.cachedTokens),
                cost: numberOrZero(usageObj.cost ?? usageObj.totalCost),
            }
            usageFromChat.cost ||= await estimateCostFromPricing(msg.model, usageFromChat)

            const usage = await readGenerationUsage(msg.id, usageFromChat)

            const toolCall = msg.choices[0].message.toolCalls?.[0]?.function
            if (!toolCall) return { content: msg.choices[0].message.content || '', usage }

            let out: string
            let args: any
            try {
                args = JSON.parse(toolCall.arguments)
                const handler = handlers[toolCall.name]
                if (!handler) throw new Error(`Tool handler for ${toolCall.name} not found`)
                out = String(await handler(args))
            } catch (e: any) {
                console.error(`Tool ${toolCall.name} failed:`, e)
                out = `Error calling tool ${toolCall.name}: ${e.message}`
            }

            // Cap tool output size to prevent context overflow
            if (out.length > 10000) out = out.slice(0, 10000) + '... (truncated)'

            msgs.push(`successfully called ${toolCall.name} ${JSON.stringify(args)}:\n${out}`)
            console.log(`${toolCall.name} call: ${out.length} chars`)
            
            const next = await getWithOptions({ model }, ...msgs)
            return { content: next.content, usage: mergeUsage(usage, next.usage) }
        } catch (error: any) {
            lastError = error
            const status = error.statusCode || error.status || (error.data$?.response$?.status)
            const isRateLimit = status === 429 || error.message?.includes('rate limit')
            
            console.error(`AI attempt ${attempt} failed for model ${model}:`, status, error.message)

            if (isRateLimit) {
                const wait = attempt * 2000
                console.log(`Rate limited. Waiting ${wait}ms...`)
                await sleep(wait)
                if (attempt >= 2 && model !== 'x-ai/grok-4.20') {
                    console.log('Switching to fallback model x-ai/grok-4.20 due to rate limits')
                    model = 'x-ai/grok-4.20'
                }
                continue
            }

            if (status === 400 || status === 404 || status === 401) {
                 if (model !== 'x-ai/grok-4.20') {
                    console.log(`Model error (${status}). Switching to fallback x-ai/grok-4.20`)
                    model = 'x-ai/grok-4.20'
                    continue
                 }
            }

            // Generic server error (5xx)
            if (status >= 500) {
                await sleep(1000)
                continue
            }

            break
        }
    }

    throw lastError || new Error('AI request failed after multiple attempts')
}

export const get = async (...msgs: ChatInput[]) => getWithOptions({}, ...msgs)
export const getText = async (...msgs: ChatInput[]) => (await get(...msgs)).content
