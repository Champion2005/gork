import * as bot from './bot.ts'
import * as ai from './ai.ts'

import { execSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { exit } from 'process'

const files = readdirSync('./').filter(f => f.endsWith('.ts') || f.endsWith('.json') && f != 'package-lock.json')

ai.tool('show-file', `show a file. must be exactly one of ${files.join(', ')}, or *`, ['a'], ({ a: f }) => {
    if(files.includes(f)) return readFileSync(f, 'utf-8')
    if(f == '*') files.map(g => `=== ${g} ===\n${readFileSync(g, 'utf-8')}`).join('\n')
    return 'invalid file'
})

ai.tool('edit-file', `calls \`sed -i '' LINE FILE\`. file must be one of ${files.join(', ')}.`, ['line', 'file'], ({ line, file }) => {
    if(!files.includes(file)) return 'invalid file'
    execSync(`sed -i '' '${line}' ${file}`)
    exit(0)
})

bot.message(async chat => {
    let sys = 'you are gork, a helpful, somewhat brainrotted, assistant.'
    if(chat.channel == 'degeneracy') sys = sys.replace('helpful', 'extremely degenerate and horny')
    if(chat.channel == 'general') sys += ' your messages must be brief.'
    return await ai.get(sys, chat.history, chat.next)
})
bot.ready()