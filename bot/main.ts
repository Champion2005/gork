import * as bot from './bot'
import * as ai from './ai'
import * as memory from './memory'
import * as config from './config'
import * as dashboardUsers from './dashboard-users'
import { migrateFromLegacy } from './storage'
import Exa from 'exa-js'

// Migrate files to persistent storage if needed
['db.json', 'usage-events.jsonl', 'audit-log.jsonl', 'bot-config.json', 'dashboard-users.json', 'dashboard-session-secret.txt']
    .forEach(migrateFromLegacy)

const exa = new Exa(process.env.EXA_API_KEY)
bot.setHistoryDepthGetter(() => config.loadConfig().historyDepth)

ai.tool('web-search', 'search a question via exa', ['query'], async ({ query }) => {
    if (!config.loadConfig().webSearchEnabled) return 'web search is disabled by admin'
    const res = await exa.search(query, { contents: { highlights: { maxCharacters: 2500 } } })
    return res.results
})

ai.tool('add-fun-fact', 'adds to memory', ['user', 'fact'], ({ user, fact }) =>
    memory.addFact({ user, fact, displayName: user }))

bot.message(async chat => {
    const cfg = config.loadConfig()
    if (cfg.deniedUserIds.includes(chat.next.id)) return ''
    if (cfg.mutedUserIds.includes(chat.next.id)) return ''

    for (const participant of [chat.next, ...chat.history]) {
        memory.upsertUserIdentity({ userId: participant.id, displayName: participant.name })
        dashboardUsers.upsertSeenIdentity({ discordId: participant.id, displayName: participant.name })
    }

    let sys = 'you are gork jr, a helpful, somewhat brainrotted, assistant. if someone asks a stupid question, respond with: https://tenor.com/view/twitter-x-gork-grok-contacting-gork-gif-8134004189220612680'
    if (cfg.degeneracyMode && chat.channel == 'degeneracy') sys = sys.replace('helpful', 'extremely degenerate and horny')
    if (cfg.generalBrief && chat.channel == 'general') sys += ' your messages must be brief.'

    const people = [...new Map([chat.next, ...chat.history, { id: 'gork', name: 'gork', msg: '' }]
        .map((entry) => [entry.id, { id: entry.id, name: entry.name }])).values()]
    sys += '\nfun facts you know about these users:\n' + memory.buildFacts(people)

    const out = await ai.getWithOptions({ model: cfg.model }, sys, chat.history, chat.next)
    memory.addUsageSample({
        userId: chat.next.id,
        displayName: chat.next.name,
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        cachedTokens: out.usage.cachedTokens,
        cost: out.usage.cost,
    })
    return out.content.slice(0, cfg.replyMaxLength)
})

bot.ready()
