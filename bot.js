require('dotenv').config()
const { Client, GatewayIntentBits } = require('discord.js')
const OpenAI = require('openai')

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY })

client.on('messageCreate', async (msg) => {
    if(!msg.content.includes(process.env.GORK_AT)) return
    msg.channel.sendTyping()
    const extra = msg.channel.name == 'degeneracy' ? 'a total perverted brainrotted smut writing freaky ai assistant.' : 'a helpful yet somewhat brainrotted assistant.'
    try {
      let replied = msg.reference ? (await msg.channel.messages.fetch(msg.reference.messageId)).content : '(there is no replied message)'
      const recent = await msg.channel.messages.fetch({ limit: 8, before: msg.id })
      const history = [...recent.values()].reverse().slice(-5).map(m => `${m.author.username}: ${m.content}`).join('\n')
      const completion = await openrouter.chat.completions.create({
        model: 'x-ai/grok-4.20', reasoning_effort: 'none', max_completion_tokens: 400,
        messages: [
          { role: 'system', content: `you are gork, ${extra} you're replying to: "${replied}"\n\nrecent messages:\n${history}` },
          { role: 'user', content: msg.content }
        ]})
      msg.reply(completion.choices[0].message.content)
    } catch (err) {
      console.error(err)
      msg.reply('error checking realness')
    }
  }
)

client.login(process.env.DISCORD_TOKEN)
