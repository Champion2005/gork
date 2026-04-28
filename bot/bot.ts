import 'dotenv/config'
import { Client, GatewayIntentBits, REST, Routes, TextChannel, type ChatInputCommandInteraction, type Message } from 'discord.js'

export const isString = 3, isInteger = 4, isUser = 6
type Chats = {
    history: { id: string; name: string; msg: string; role: 'user' | 'assistant'; isReply?: boolean }[], next: { id: string; name: string; msg: string },
    channel: string, message?: Message, interaction?: ChatInputCommandInteraction
}
type Handler = (chat: Chats, args: Record<string, unknown>) => void | Promise<string | undefined>

const cmds: { name: string; args: Record<string, number>; handler: Handler }[] = []
let msgHandler: Handler
export const command = (name: string, args: Record<string, number>, handler: Handler) => void cmds.push({ name, args, handler })
export const message = (h: Handler) => msgHandler = h
let historyDepthGetter = () => 12
export const setHistoryDepthGetter = (getter: () => number) => { historyDepthGetter = getter }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })

const getArgValue = (int: ChatInputCommandInteraction, key: string, type: number) =>
    type == isInteger ? int.options.getInteger(key) : type == isUser ? int.options.getUser(key) : int.options.getString(key)

const buildOptions = (args: Record<string, number>) => Object.entries(args).map(([name, type]) => ({ name, description: 'gork', type, required: true }))

const buildDiscordCommands = () => {
    const roots = new Map<string, any>()

    for (const cmd of cmds) {
        const [root, sub] = cmd.name.split(' ')
        if (!roots.has(root)) roots.set(root, { name: root, description: 'gork', options: [] })
        if (sub) {
            roots.get(root).options.push({ name: sub, description: 'gork', type: 1, options: buildOptions(cmd.args) })
        } else {
            roots.get(root).options = buildOptions(cmd.args)
        }
    }

    return [...roots.values()]
}

const buildChats = async (msg: Message, n = 12): Promise<Chats> => {
    // Fetch recent history
    const msgs = await msg.channel.messages.fetch({ limit: Math.max(n * 2, 20) })
    const allRecent = [...msgs.values()].reverse().filter(m => m.id !== msg.id)
    
    // Identify reply chain
    const replyChainIds = new Set<string>()
    let current: Message | null = msg
    
    // Trace back up to n messages in the reply chain
    let traceCount = 0
    while (current && current.reference && current.reference.messageId && traceCount < n) {
        try {
            const refId = current.reference.messageId
            const ref = msgs.get(refId) || await current.fetchReference()
            replyChainIds.add(ref.id)
            current = ref
            traceCount++
        } catch {
            break
        }
    }

    // Combine recent messages and tag those in the reply chain
    // We want to keep the N most recent messages, but ensure reply chain members are present
    const history = allRecent
        .slice(-n) // Keep it focused on most recent N
        .map(m => ({
            id: m.author.id,
            name: m.author.username,
            msg: m.content,
            role: m.author.id === client.user!.id ? 'assistant' : (m.author.bot ? 'assistant' : 'user') as 'user' | 'assistant',
            isReply: replyChainIds.has(m.id)
        }))

    return { history, next: { id: msg.author.id, name: msg.author.username, msg: msg.content }, channel: (msg.channel as TextChannel).name, message: msg }
}

export const ready = () => {
    client.on('ready', async () =>
        new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!)
            .put(Routes.applicationCommands(client.user!.id), { body: buildDiscordCommands() }))

    client.on('interactionCreate', async int => {
        if (!int.isChatInputCommand()) return
        
        const sub = int.options.getSubcommand(false)
        const cmdName = sub ? `${int.commandName} ${sub}` : int.commandName
        const cmd = cmds.find(c => c.name === cmdName)
        if (!cmd) {
            await int.reply({ content: 'command not found', ephemeral: true })
            return
        }

        await int.deferReply()
        try {
            const args = Object.fromEntries(Object.keys(cmd.args).map(key => [key, getArgValue(int, key, cmd.args[key])]))
            const reply = await cmd.handler({
                history: [],
                next: { id: int.user.id, name: int.user.username, msg: '' },
                channel: int.channel && !int.channel.isDMBased() ? (int.channel as TextChannel).name : 'dm',
                interaction: int
            }, args)
            if (reply) await int.editReply(reply)
            else await int.deleteReply()
        } catch (e: any) {
            console.error('Interaction error:', e)
            await int.editReply(`Error: ${e.message}`)
        }
    })

    client.on('messageCreate', async msg => {
        if (msg.author.bot || msg.author.id == client.user!.id) return
        if (!msg.mentions.members?.has(client.user!.id)) return
        
        msg.channel.sendTyping()
        const chat = await buildChats(msg, historyDepthGetter())
        if (msgHandler) {
            const reply = await msgHandler(chat, {})
            if (reply && reply.trim()) await msg.reply(reply)
        }
    })

    const token = process.env.DISCORD_TOKEN
    if (!token) throw new Error('DISCORD_TOKEN is not set')
    client.login(token)
}
