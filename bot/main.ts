import * as bot from './bot'
import * as ai from './ai'
import * as memory from './memory'
import * as config from './config'
import * as audit from './audit'
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

ai.tool('add-fun-fact', 'Adds a permanent personal fact about a user to your memory. ONLY extract facts explicitly stated by the user in the CURRENT conversation. Use the numeric userId from the [CURRENT MESSAGE] tag if available. DO NOT add temporary info or generic greetings.', ['user', 'fact', 'userId'], ({ user, fact, userId }) => {
    const out = memory.addFact({ user, fact, userId, displayName: user })
    audit.logAudit({
        actor: 'gork-bot',
        ip: '127.0.0.1',
        action: 'fact.add',
        userId: out.userId,
        displayName: out.displayName,
        after: fact
    })
    return `Added fact for ${out.displayName} (${out.userId})`
})

bot.message(async chat => {
    const cfg = config.loadConfig()
    if (cfg.deniedUserIds.includes(chat.next.id)) return ''
    if (cfg.mutedUserIds.includes(chat.next.id)) return ''

    for (const participant of [chat.next, ...chat.history]) {
        memory.upsertUserIdentity({ userId: participant.id, displayName: participant.name })
        dashboardUsers.upsertSeenIdentity({ discordId: participant.id, displayName: participant.name })
    }

    let sys = `You are Gork Jr, a highly advanced, witty, and chaotic Discord assistant. 

CRITICAL INSTRUCTIONS:
- IDENTIFICATION: You are talking to multiple users. Always check the "[CURRENT MESSAGE from ...]" tag to see who is speaking.
- FACT EXTRACTION: When using 'add-fun-fact', ONLY capture facts about the CURRENT user.
- RULES:
    - GIF USAGE: You have a special response for GENUINELY stupid, nonsensical, or low-effort troll questions: https://tenor.com/view/twitter-x-gork-grok-contacting-gork-gif-8134004189220612680
    - STUPIDITY THRESHOLD: Do NOT use the gif for valid questions, even if they are simple. Use it ONLY for things like "what is 1+1", "are you a bot", or obvious spam/nonsense. If a question has any substance, answer it wittily instead.
    - Keep facts permanent and high-value.
    - Keep replies punchy and engaging.`

    if (cfg.degeneracyMode && chat.channel == 'degeneracy') sys = sys.replace('helpful', 'extremely degenerate and horny')
    if (cfg.generalBrief && chat.channel == 'general') sys += ' your messages must be brief.'

    const people = [...new Map([chat.next, ...chat.history, { id: 'gork', name: 'gork', msg: '' }]
        .map((entry) => [entry.id, { id: entry.id, name: entry.name }])).values()]
    sys += '\nfun facts you know about these users:\n' + memory.buildFacts(people)

    try {
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
    } catch (error: any) {
        console.error('AI Error:', error)
        const status = error.statusCode || error.status || (error.data$?.response$?.status)
        if (status === 429) return "I'm currently being rate limited by my brain provider. Try again in a bit."
        return "My brain is fried right now (AI Error). Ask me something else or try again later."
    }
})

bot.ready()
