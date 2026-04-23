import 'dotenv/config'
import { Client, GatewayIntentBits, REST, Routes, TextChannel, type ChatInputCommandInteraction, type Message } from 'discord.js'

export const isString = 3, isInteger = 4, isUser = 6
type Chats = {
    history: { name: string; msg: string }[], next: { name: string; msg: string },
    channel: string, message?: Message, interaction?: ChatInputCommandInteraction
}
type Handler = (chat: Chats, args: Record<string, unknown>) => void | Promise<string>

const cmds: { name: string; args: Record<string, number>; handler: Handler }[] = []
let msgHandler: Handler
export const command = (name: string, args: Record<string, number>, handler: Handler) => void cmds.push({ name, args, handler })
export const message = (h: Handler) => msgHandler = h

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })

const getArgValue = (int: ChatInputCommandInteraction, key: string, type: number) =>
    type == isInteger ? int.options.getInteger(key) : type == isUser ? int.options.getUser(key) : int.options.getString(key)

const buildOptions = (args: Record<string, number>) => Object.entries(args).map(([name, type]) => ({ name, description: 'gork', type, required: true }))

const buildDiscordCommands = () => {
    const roots = new Map<string, any>()

    for (const cmd of cmds) {
        const [root, sub] = cmd.name.split(' ')
        if (!roots.has(root)) roots.set(root, { name: root, description: 'gork', options: [], })
        roots.get(root).options.push({ name: sub, description: 'gork', type: 1, options: buildOptions(cmd.args) })
    }

    return [...roots.values()]
}

const buildChats = async (msg: Message, n = 12): Promise<Chats> => {
    const history = await msg.channel.messages.fetch({ limit: 20 })
        .then((msgs: Map<any, Message>) => [...msgs.values()].reverse().slice(-n).map(m => ({ name: m.author.username, msg: m.content })))
    history.pop()
    return { history, next: { name: msg.author.username, msg: msg.content }, channel: (msg.channel as TextChannel).name, message: msg }
}

export const ready = () => {
    client.on('ready', async () =>
        new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!)
            .put(Routes.applicationCommands(client.user!.id), { body: buildDiscordCommands() }))

    client.on('interactionCreate', async int => {
        if (!int.isChatInputCommand()) return
        await int.reply({ content: 'gimmie a minute bruh', ephemeral: true })
    })

    client.on('messageCreate', async msg => {
        if (msg.author.bot || !msg.mentions.members?.has(client.user!.id)) return
        msg.channel.sendTyping()
        const chat = await buildChats(msg)
        if(msgHandler) await msg.reply(await msgHandler(chat, {})!)
    })

    const token = process.env.DISCORD_TOKEN
    if (!token) throw new Error('DISCORD_TOKEN is not set')
    client.login(token)
}