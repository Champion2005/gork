import { OpenRouter } from '@openrouter/sdk'

const or = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! }), tools: any[] = [], handlers: { [key: string]: (args: any) => any } = {}

export const tool = (name: string, desc: string: params: string[], func: (args: any) => any) => {
    const parameters = { type: 'object', properties: {} }
    tools.push({ type: 'function', function: { name, description: 'gork tool', parameters } })
    handlers[name] = func
}

const buildMsgs = (args: (string | {msg: string, name: string} | {msg: string, name: string}[])[]): {role: 'system' | 'user' | 'assistant', content: string}[] => [
    {role: 'system', content: args[0] as string }, 
    {role: 'user', content: args.slice(1).flat().map(a => typeof a == 'string' ? a : `${a.name}: ${a.msg}`).join('\n')},
    {role: 'assistant', content: 'gork: ' }
]

export const get = async (...args: (string | { msg: string; name: string } | { msg: string; name: string }[])[]): Promise<string> => {
    const allowTools = (args[0] as string).includes('result for') ? [] : tools
    console.log(tools[0])
    const msg = await or.chat.send({ chatRequest: { messages: buildMsgs(args), model: 'x-ai/grok-4.20', tools: allowTools } })
        .then(r => r.choices[0].message)

    const tool = msg.toolCalls?.[0]?.function
    if (!tool) return msg.content

    console.log('tool call for ' + tool.name + ' with args: ' + tool.arguments)
    const out = await handlers[tool.name]({})
    args[0] = args[0] + '\nresult for ' + tool.name + ': ' + JSON.stringify(out) + '\n'
    console.log('result for ' + tool.name + ': <' + out.slice(0, 200) + '>')
    

    return await get(...args)
}