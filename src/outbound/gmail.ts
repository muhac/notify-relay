import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import { addressing, base64, mime, recipients, refuseRecipients, utf8 } from './mail'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export const gmail: Outbound = {
    type: 'gmail',
    params: ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'TO'],
    optional: ['FROM', 'ALLOW_TO'],
    recipients: refuseRecipients,
    async send(message, params, { fetch, signal, channel }) {
        const { headers } = addressing(recipients(params, message.to?.[channel]), params.FROM)

        const token = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: param(params, 'CLIENT_ID'),
                client_secret: param(params, 'CLIENT_SECRET'),
                refresh_token: param(params, 'REFRESH_TOKEN'),
                grant_type: 'refresh_token',
            }),
            signal,
        })
        if (!token.ok) {
            const error = await token.clone().json().then((body) => (body as { error?: unknown }).error, () => undefined)
            if (error === 'invalid_grant') throw new Error('refresh token revoked or expired (invalid_grant)')
            await expectOk(token)
        }
        const { access_token } = (await token.json()) as { access_token: string }

        const sent = await fetch(SEND_URL, {
            method: 'POST',
            headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ raw: base64(utf8(mime(headers, message))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }),
            signal,
        })
        await expectOk(sent)
    },
}
