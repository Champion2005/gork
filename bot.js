require('dotenv').config()
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js')
const OpenAI = require('openai')
const fs = require('fs')
const path = require('path')

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY })

// Load user configs
const configsPath = path.join(__dirname, 'configs.json');
let userConfigs = {};
if (fs.existsSync(configsPath)) {
    userConfigs = JSON.parse(fs.readFileSync(configsPath, 'utf8'));
}

// Load user memories
const memoriesPath = path.join(__dirname, 'memories.json');
let userMemories = {};
if (fs.existsSync(memoriesPath)) {
    try {
        userMemories = JSON.parse(fs.readFileSync(memoriesPath, 'utf8'));
    } catch (e) {
        console.error("Error loading memories.json:", e);
    }
}

function saveMemories() {
    fs.writeFileSync(memoriesPath, JSON.stringify(userMemories, null, 2));
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        {
            name: 'memory',
            description: 'Manage memories for Gork',
            options: [
                {
                    name: 'view',
                    description: 'View the memories Gork has saved about you or someone else',
                    type: 1, // SUB_COMMAND
                    options: [{ name: 'user', description: 'The user to view memories of', type: 6, required: false }] // USER
                },
                {
                    name: 'add',
                    description: 'Manually add a memory about yourself',
                    type: 1, // SUB_COMMAND
                    options: [{ name: 'fact', description: 'The fact to remember', type: 3, required: true }] // STRING
                },
                {
                    name: 'delete',
                    description: 'Delete a specific memory about yourself by index',
                    type: 1, // SUB_COMMAND
                    options: [{ name: 'index', description: 'The index of the memory to delete (starting at 1)', type: 4, required: true }] // INTEGER
                },
                {
                    name: 'wipe',
                    description: 'Wipe all memories Gork has saved about you',
                    type: 1 // SUB_COMMAND
                },
                {
                    name: 'botview',
                    description: 'View the personality traits Gork has learned (Public)',
                    type: 1 // SUB_COMMAND
                },
                {
                    name: 'botadd',
                    description: 'Manually add a personality trait to Gork (Public)',
                    type: 1, // SUB_COMMAND
                    options: [{ name: 'trait', description: 'The personality trait to add', type: 3, required: true }]
                },
                {
                    name: 'botdelete',
                    description: 'Delete a specific personality trait by index (Public)',
                    type: 1, // SUB_COMMAND
                    options: [{ name: 'index', description: 'The index of the trait to delete (starting at 1)', type: 4, required: true }]
                },
                {
                    name: 'botwipe',
                    description: 'Wipe all personality traits Gork has learned (Public)',
                    type: 1 // SUB_COMMAND
                }
            ]
        },
        {
            name: 'gork',
            description: 'Commands related to Gork itself',
            options: [
                {
                    name: 'usage',
                    description: 'View Gork\'s OpenRouter API credit usage',
                    type: 1 // SUB_COMMAND
                },
                {
                    name: 'leaderboard',
                    description: 'View the leaderboard of who mentions Gork the most',
                    type: 1 // SUB_COMMAND
                }
            ]
        }
    ];

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error reloading commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'memory') {
        const subCommand = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const botId = '1495533551800549566';

        // Initialize if they don't exist
        if (!userMemories[userId]) userMemories[userId] = { facts: [] };
        if (!userMemories[botId]) userMemories[botId] = { facts: [] };

        if (subCommand === 'view') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const targetId = targetUser.id;
            const isSelf = targetId === interaction.user.id;

            if (userMemories[targetId] && userMemories[targetId].facts && userMemories[targetId].facts.length > 0) {
                const formatted = userMemories[targetId].facts.map((f, i) => `**${i + 1}.** ${f}`).join('\n');
                const title = isSelf ? "**What I know about you:**" : `**What I know about <@${targetId}>:**`;
                let content = `${title}\n${formatted}`;
                if (content.length > 2000) {
                    content = content.substring(0, 1997) + '...';
                }
                const replyObj = { content, allowedMentions: { parse: [] } };
                if (isSelf) replyObj.flags = 64;
                await interaction.reply(replyObj);
            } else {
                const title = isSelf ? "I don't have any memories saved about you yet!" : `I don't have any memories saved about <@${targetId}> yet!`;
                const replyObj = { content: title, allowedMentions: { parse: [] } };
                if (isSelf) replyObj.flags = 64;
                await interaction.reply(replyObj);
            }
        } else if (subCommand === 'add') {
            const fact = interaction.options.getString('fact');
            userMemories[userId].facts.push(fact);
            saveMemories();
            await interaction.reply({ content: `✅ Added memory: "${fact}"`, flags: 64 });
        } else if (subCommand === 'delete') {
            const index = interaction.options.getInteger('index');
            if (index > 0 && index <= userMemories[userId].facts.length) {
                const removed = userMemories[userId].facts.splice(index - 1, 1);
                saveMemories();
                await interaction.reply({ content: `✅ Deleted memory: "${removed[0]}"`, flags: 64 });
            } else {
                await interaction.reply({ content: `❌ Invalid index. Please use \`/memory view\` to see the indexes.`, flags: 64 });
            }
        } else if (subCommand === 'wipe') {
            userMemories[userId].facts = [];
            saveMemories();
            await interaction.reply({ content: `✅ Your memories have been completely wiped.`, flags: 64 });
        } else if (subCommand === 'botview') {
            if (userMemories[botId].facts.length > 0) {
                const formatted = userMemories[botId].facts.map((f, i) => `**${i + 1}.** ${f}`).join('\n');
                let content = `**My current programmed traits:**\n${formatted}`;
                if (content.length > 2000) {
                    content = content.substring(0, 1997) + '...';
                }
                await interaction.reply({ content });
            } else {
                await interaction.reply({ content: `I don't have any custom personality traits saved yet!` });
            }
        } else if (subCommand === 'botadd') {
            const trait = interaction.options.getString('trait');
            userMemories[botId].facts.push(trait);
            saveMemories();
            await interaction.reply({ content: `✅ <@${interaction.user.id}> added bot trait: "${trait}"` });
        } else if (subCommand === 'botdelete') {
            const index = interaction.options.getInteger('index');
            if (index > 0 && index <= userMemories[botId].facts.length) {
                const removed = userMemories[botId].facts.splice(index - 1, 1);
                saveMemories();
                await interaction.reply({ content: `✅ <@${interaction.user.id}> deleted bot trait: "${removed[0]}"` });
            } else {
                await interaction.reply({ content: `❌ Invalid index. Please use \`/memory botview\` to see the indexes.` });
            }
        } else if (subCommand === 'botwipe') {
            userMemories[botId].facts = [];
            saveMemories();
            await interaction.reply({ content: `✅ <@${interaction.user.id}> wiped all my custom personality traits.` });
        }
    } else if (interaction.commandName === 'gork') {
        const subCommand = interaction.options.getSubcommand();

        if (subCommand === 'usage') {
            try {
                await interaction.deferReply();
                const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
                    headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
                });
                const data = await response.json();
                if (data && data.data) {
                    const usage = data.data.usage;
                    const limit = data.data.limit ? data.data.limit.toFixed(2) : 'Unlimited';
                    // Note: OpenRouter API doesn't provide total token count via this endpoint.
                    await interaction.editReply({ content: `📊 **Gork API Usage (OpenRouter):**\n- **Credits Used:** $${usage}\n- **Limit:** $${limit}\n*(Note: OpenRouter does not track total lifetime token counts via this API endpoint)*` });
                } else {
                    await interaction.editReply({ content: `❌ Failed to fetch API stats.` });
                }
            } catch (err) {
                console.error(err);
                await interaction.editReply({ content: `❌ Error fetching API stats.` });
            }
        } else if (subCommand === 'leaderboard') {
            await interaction.deferReply();
            const users = [];
            for (const [id, memory] of Object.entries(userMemories)) {
                if (id !== '1495533551800549566' && (memory.mentions || memory.cost)) {
                    let name = memory.displayName;
                    if (!name) {
                        try {
                            const u = await interaction.client.users.fetch(id);
                            name = u.displayName || u.username;
                            userMemories[id].displayName = name; // Cache it
                        } catch (e) {
                            name = `User ${id}`;
                        }
                    }
                    users.push({ name, mentions: memory.mentions || 0, cost: memory.cost || 0 });
                }
            }
            saveMemories();
            
            // Sort primarily by cost, then by mentions
            users.sort((a, b) => b.cost - a.cost || b.mentions - a.mentions);
            const top = users.slice(0, 10);
            
            if (top.length === 0) {
                await interaction.editReply({ content: `No one has used me yet! (At least, not since I started tracking...)` });
            } else {
                const formatted = top.map((u, i) => `**${i + 1}.** ${u.name} - ${u.mentions} mentions ($${u.cost.toFixed(4)})`).join('\n');
                await interaction.editReply({ 
                    content: `🏆 **Gork Usage Leaderboard:**\n${formatted}`,
                    allowedMentions: { parse: [] }
                });
            }
        }
    }
});

// Background LLM task to extract memories
async function updateMemory(userId, username, messageContent) {
    if (!userMemories[userId]) {
        userMemories[userId] = { facts: [] };
    }
    
    try {
        const response = await openrouter.chat.completions.create({
            model: 'openrouter/free',
            messages: [
                { 
                    role: 'system', 
                    content: `You are an internal background process. Your job is to extract long-term, personal facts ONLY about the user named "${username}" from their message.
RULES:
1. ONLY extract personal facts about "${username}" (e.g., their name, age, likes, dislikes, physical traits, location).
2. DO NOT extract facts about other people mentioned in the text.
3. DO NOT extract general statements, jokes, or questions.
4. If there are no new personal facts about "${username}", you MUST reply with exactly "NONE".
5. If you find facts, format each as a short, objective sentence starting with their name (e.g., "${username} has a dog"). DO NOT make up or guess facts.
6. Separate multiple facts with a pipe character '|'. Do NOT output any other text.` 
                },
                { role: 'user', content: messageContent }
            ],
            max_tokens: 100,
            temperature: 0.1
        });
        
        const content = response.choices[0]?.message?.content || "";
        const output = content.trim();
        // Check if output has facts and isn't just "NONE"
        if (output && !output.toUpperCase().includes("NONE") && !output.toLowerCase().includes("we need to extract")) {
            const newFacts = output.split('|').map(f => f.trim()).filter(f => f.length > 0);
            if (newFacts.length > 0) {
                userMemories[userId].facts.push(...newFacts);
                
                // Limit to 50 facts per user (FIFO queue-based limit to stay well under 100 lines/1000 words)
                if (userMemories[userId].facts.length > 50) {
                    userMemories[userId].facts = userMemories[userId].facts.slice(-50);
                }
                
                saveMemories();
                console.log(`[Memory] Learned about ${username}:`, newFacts);
            }
        }
    } catch (err) {
        console.error("Memory extraction error:", err.message);
    }
}

// Background LLM task to extract bot personality traits
async function updateBotMemory(messageContent) {
    const botId = '1495533551800549566';
    if (!userMemories[botId]) {
        userMemories[botId] = { facts: [] };
    }
    
    try {
        const response = await openrouter.chat.completions.create({
            model: 'openrouter/free',
            messages: [
                { 
                    role: 'system', 
                    content: `You are an internal background process. Your job is to extract personality traits, instructions, or facts about the bot "gork" (or "you") from the user's message.
RULES:
1. ONLY extract personality traits or facts intended for the bot itself (e.g., "you are mean", "gork likes cheese").
2. DO NOT extract facts about the user sending the message.
3. If there are no new traits or instructions for the bot, you MUST reply with exactly "NONE".
4. If you find traits, format each as a short, objective sentence starting with "You" (e.g., "You are highly sarcastic", "You love programming").
5. Separate multiple facts with a pipe character '|'. Do NOT output any other text.` 
                },
                { role: 'user', content: messageContent }
            ],
            max_tokens: 100,
            temperature: 0.1
        });
        
        const content = response.choices[0]?.message?.content || "";
        const output = content.trim();
        if (output && !output.toUpperCase().includes("NONE") && !output.toLowerCase().includes("we need to extract")) {
            const newFacts = output.split('|').map(f => f.trim()).filter(f => f.length > 0);
            if (newFacts.length > 0) {
                userMemories[botId].facts.push(...newFacts);
                if (userMemories[botId].facts.length > 50) {
                    userMemories[botId].facts = userMemories[botId].facts.slice(-50);
                }
                saveMemories();
                console.log(`[Memory] Learned bot trait:`, newFacts);
            }
        }
    } catch (err) {
        console.error("Bot memory extraction error:", err.message);
    }
}

client.on('messageCreate', async (msg) => {
    if(msg.author.bot) return
    if(!msg.content.includes(process.env.GORK_AT)) return
    msg.channel.sendTyping()

    const userId = msg.author.id;
    if (!userMemories[userId]) userMemories[userId] = { facts: [] };
    userMemories[userId].mentions = (userMemories[userId].mentions || 0) + 1;
    saveMemories();

    const userDisplayName = msg.member?.displayName || msg.author.displayName || msg.author.username;

    // Trigger memory update asynchronously without awaiting it
    updateMemory(msg.author.id, userDisplayName, msg.content).catch(console.error);
    updateBotMemory(msg.content).catch(console.error);

    // Freaky mode is ON by default in degeneracy, OFF everywhere else
    let extra = msg.channel.name === 'degeneracy' 
        ? 'a total perverted brainrotted smut writing freaky ai assistant.' 
        : 'a helpful yet somewhat brainrotted assistant.';
    
    // Check for specific user instructions to override the default personality
    if (userConfigs.hasOwnProperty(msg.author.id) && userConfigs[msg.author.id]) {
        extra = userConfigs[msg.author.id];
    }

    try {
      let replied = '(there is no replied message)';
      if (msg.reference) {
          const repliedMsg = await msg.channel.messages.fetch(msg.reference.messageId);
          replied = `"${repliedMsg.member?.displayName || repliedMsg.author.displayName || repliedMsg.author.username}: ${repliedMsg.content}"`;
      }
      
      const recent = await msg.channel.messages.fetch({ limit: 8, before: msg.id })
      const history = [...recent.values()].reverse().slice(-5).map(m => `${m.member?.displayName || m.author.displayName || m.author.username}: ${m.content}`).join('\n')
      
      let systemPrompt = `You are gork, ${extra}\n`;
      
      const botId = '1495533551800549566';
      if (userMemories[botId] && userMemories[botId].facts.length > 0) {
          systemPrompt += `\n<your_personality_traits>\nYour users have programmed you with the following traits. YOU MUST ADOPT THESE BEHAVIORS:\n- ${userMemories[botId].facts.join('\n- ')}\n</your_personality_traits>\n`;
      }
      systemPrompt += `\nCRITICAL RULES REGARDING USERS:\n`;
      systemPrompt += `1. NEVER mix up information between different users.\n`;
      systemPrompt += `2. ONLY use the <memory_about_current_user> block to answer personal questions about the person you are talking to. Do NOT use <chat_history> to find personal facts, as it contains multiple people.\n`;
      systemPrompt += `3. If a personal detail is not in the <memory_about_current_user> block, you MUST say you don't know it. Do NOT guess, and do NOT attribute another user's details to them.\n\n`;

      if (msg.channel.name === 'general') {
          systemPrompt += `IMPORTANT: Because you are in the #general channel, your responses MUST be extremely short and concise.\n`;
      }
      
      let memoryText = "";
      if (userMemories[msg.author.id] && userMemories[msg.author.id].facts.length > 0) {
          memoryText = `\n<memory_about_current_user name="${userDisplayName}">\n- ${userMemories[msg.author.id].facts.join('\n- ')}\n</memory_about_current_user>\n`;
      }

      systemPrompt += `\n<chat_history>\n${history}\n</chat_history>\n`;
      if (replied !== '(there is no replied message)') {
          systemPrompt += `\n<replied_to_message>\n${replied}\n</replied_to_message>\n`;
      }
      systemPrompt += `${memoryText}`;

      const maxTokens = msg.channel.id === '1496554877374038248' ? 800 : 400;

      const completion = await openrouter.chat.completions.create({
        model: 'x-ai/grok-4.20', reasoning_effort: 'none', max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${userDisplayName}: ${msg.content}` }
        ]})
        
      const cost = completion.usage?.cost || 0;
      if (cost > 0) {
          userMemories[msg.author.id].cost = (userMemories[msg.author.id].cost || 0) + cost;
          saveMemories();
      }
        
      let replyText = completion.choices[0]?.message?.content || "*(Brainrot overload, my circuits fried. Try again.)*";
      if (replyText.length > 2000) {
          replyText = replyText.substring(0, 1997) + '...';
      }
      msg.reply(replyText)
    } catch (err) {
      console.error(err)
      msg.reply('error checking realness')
    }
  }
)

client.login(process.env.DISCORD_TOKEN)
