import * as bot from './bot.ts'
import * as ai from './ai.ts'
import * as memory from './memory.ts'
import { readFileSync, readdirSync, writeFileSync } from 'fs'
import { exit } from 'process'
const files = readdirSync('./').filter(f => f.endsWith('.ts') || f.endsWith('.json') && f != 'package-lock.json')
import Exa from "exa-js"
const exa = new Exa(process.env.EXA_API_KEY)
let needReboot = false

ai.tool('read-file', `read a file. ALWAYS ensure you have context for files you're talking about or editing! must be exactly one of ${files} or *`, ['file'], ({ file }) => {
    if(files.includes(file)) return readFileSync(file, 'utf-8')
    if(file == '*') files.map(f => `=== ${f} ===\n${readFileSync(f, 'utf-8')}`).join('\n')
    return 'error: file not found in this directory'
})

ai.tool('write-file', `write the new content to a file, overwriting it if needed. file must be one of ${files}.`, ['file', 'content'], ({ content, file }) => {
    writeFileSync(file, content)
    needReboot = true
})

ai.tool('web-search', 'search a question via exa', ['query'], ({ query }) =>
    exa.search(query, { contents: { highlights: { maxCharacters: 2500 } } }).then(r => JSON.stringify(r.results)))

ai.tool('add-fun-fact', 'adds to memory. use when asked or when something worth remembering happens', ['user', 'fact'], memory.addFact)

bot.message(async chat => {
    let sys = 'you are gork jr, a helpful, somewhat brainrotted, assistant.'
    if(chat.channel == 'degeneracy') sys = sys.replace('helpful', 'extremely degenerate and horny')
    if(chat.channel == 'general') sys += ' your messages must be brief.'

    const names = Array.from(new Set(['gork', ...chat.history.map(h => h.name), chat.next.name]))
    sys += '\nfun facts you know about these users:\n' + memory.buildFacts(names)

    const res = await ai.get(sys, chat.history, chat.next)
    if(needReboot) setInterval(() => exit(0), 2000)
    return res.slice(0, 1990)
})
bot.ready()