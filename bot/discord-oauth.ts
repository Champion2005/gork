type DiscordOAuthUser = {
    id?: string
    username?: string
    global_name?: string | null
}

const clientId = process.env.DISCORD_OAUTH_CLIENT_ID?.trim() ?? '1497303665415950580'
const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET?.trim() ?? ''
const discordApi = 'https://discord.com/api'

const resolveDisplayName = (user: DiscordOAuthUser) =>
    user.global_name?.trim() || user.username?.trim() || user.id || ''

export const isDiscordOAuthConfigured = () => Boolean(clientId && clientSecret)

export const buildDiscordAuthorizeUrl = ({ state, redirectUri }: { state: string; redirectUri: string }) => {
    if (!isDiscordOAuthConfigured()) throw new Error('Discord OAuth is not configured')
    const url = new URL(`${discordApi}/oauth2/authorize`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('scope', 'identify')
    url.searchParams.set('state', state)
    url.searchParams.set('redirect_uri', redirectUri)
    return url.toString()
}

export const exchangeDiscordCode = async ({ code, redirectUri }: { code: string; redirectUri: string }) => {
    if (!isDiscordOAuthConfigured()) throw new Error('Discord OAuth is not configured')

    const tokenResponse = await fetch(`${discordApi}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
        }),
    })
    if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status})`)
    const token = await tokenResponse.json() as { access_token?: string }
    if (typeof token.access_token != 'string' || !token.access_token) throw new Error('Discord token exchange did not return an access token')

    const identityResponse = await fetch(`${discordApi}/users/@me`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
    })
    if (!identityResponse.ok) throw new Error(`Discord identity lookup failed (${identityResponse.status})`)
    const identity = await identityResponse.json() as DiscordOAuthUser
    if (typeof identity.id != 'string' || !identity.id.trim()) throw new Error('Discord identity response missing a user id')

    return {
        discordId: identity.id.trim(),
        displayName: resolveDisplayName(identity),
    }
}
