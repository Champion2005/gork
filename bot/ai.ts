import { OpenRouter } from '@openrouter/sdk'

const or = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! }), tools: any[] = [], handlers: { [key: string]: (args: any) => any } = {}

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

export const get = async (...msgs: (string | { msg: string; name: string } | { msg: string; name: string }[])[]): Promise<string> => {
    const msg = await or.chat.send({ chatRequest: { messages: buildMsgs(msgs), model: 'x-ai/grok-4.20', tools, reasoning: { effort: 'none' } } })
        .then(r => r.choices[0].message)

    const tool = msg.toolCalls?.[0]?.function
    if (!tool) return msg.content
    const args = JSON.parse(tool.arguments)
    const out = await handlers[tool.name](args)
    msgs.push(`successfully called ${tool.name} ${JSON.stringify(args)}:\n${out}`)
    if(args.content) args.content = '<truncated>'
    console.log(`${tool.name} ${JSON.stringify(args)}: ${out?.length}`)
    return await get(...msgs)
}