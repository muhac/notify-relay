import { param } from '../core/channels'
import type { Outbound } from '../core/deliver'
import { expectOk } from '../core/http'
import type { Message } from '../core/message'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

// Sends as the account that granted the refresh token, which only needs gmail.send. Each message mints
// its own access token: the relay keeps no state. The title also opens the body, since email-to-SMS
// gateways drop the subject
export const gmail: Outbound = {
    type: 'gmail',
    params: ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'TO'],
    async send(message, params, { fetch, signal }) {
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
            body: JSON.stringify({ raw: base64(utf8(mime(param(params, 'TO'), message))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }),
            signal,
        })
        await expectOk(sent)
    },
}

function mime(to: string, message: Message): string {
    const text = [message.title, message.body, message.url].filter(Boolean).join('\n\n')
    return [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${base64(utf8(message.title))}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        (base64(utf8(text)).match(/.{1,76}/g) ?? []).join('\r\n'),
    ].join('\r\n')
}

function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

function base64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}
