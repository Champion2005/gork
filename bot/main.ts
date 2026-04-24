import * as bot from './bot.ts'
import * as ai from './ai.ts'
import * as memory from './memory.ts'
import { readFileSync, readdirSync, writeFileSync } from 'fs'
import { exit } from 'process'
import Exa from "exa-js"
const exa = new Exa(process.env.EXA_API_KEY)

// const files = readdirSync('./bot').filter(f => f.endsWith('.ts') || f.endsWith('.json'))
// ai.tool('read-file', `read a file. ALWAYS ensure you have context for files you talk about! must be * or in ${files}`, ['file'], ({ file }) => {
//     if(files.includes(file)) return readFileSync(file, 'utf-8')
//     if(file == '*') files.map(f => `>> ${f}\n${readFileSync(f, 'utf-8')}`)
//     return 'error: not found'
// })
// ai.tool('write-file', `(over)write file. file must be in ${files}.`, ['file', 'data'], ({ data, file }) => writeFileSync(file, data))

ai.tool('web-search', 'search a question via exa', ['query'], async ({ query }) => await exa.search(query, { contents: { highlights: { maxCharacters: 2500 } } }).results)
ai.tool('add-fun-fact', 'adds to memory', ['user', 'fact'], memory.addFact)

bot.message(async chat => {
    let sys = 'you are gork jr, a helpful, somewhat brainrotted, assistant.'
    if(chat.channel == 'degeneracy') sys = sys.replace('helpful', 'extremely degenerate and horny')
    if(chat.channel == 'general') sys += ' your messages must be brief.'

    sys += '\nfun facts you know about these users:\n' + memory.buildFacts([...new Set(['gork', ...chat.history.map(h => h.name), chat.next.name])])

    const out = await ai.get(sys, chat.history, chat.next)
    memory.addUsageSample({
        user: chat.next.name,
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        cachedTokens: out.usage.cachedTokens,
        cost: out.usage.cost,
    })
    return out.content.slice(0, 1990)
})
bot.ready()
