import { describe, expect, it } from 'vitest'
import { webhook } from '../src/inbound/webhook'

describe('webhook', () => {
    it('defaults the level to normal', () => {
        expect(webhook.parse({ title: 'deploy done' })).toEqual([{ title: 'deploy done', level: 'normal' }])
    })

    it('keeps every field of the contract', () => {
        const draft = {
            title: 'HostDown oicna',
            text: 'no samples for 15m',
            rich: '<p>no samples for <b>15m</b></p>',
            level: 'high',
            url: 'https://grafana.example/alerting',
            key: 'group-1',
            group: 'alerts',
            to: 'ops@example.com, "Doe, Jane" <jane@example.com>',
        }
        expect(webhook.parse(draft)).toEqual([draft])
    })

    it('rejects a body that is not an object', () => {
        for (const body of [null, 'title', 42, ['title']]) {
            expect(() => webhook.parse(body)).toThrow('body must be a JSON object')
        }
    })

    it('rejects unknown fields, so a misspelling surfaces at the sender', () => {
        expect(() => webhook.parse({ titel: 'x' })).toThrow("unknown field 'titel'")
        expect(() => webhook.parse({ title: 'x', source: 'grafana' })).toThrow("unknown field 'source'")
        expect(() => webhook.parse({ title: 'x', body: 'old' })).toThrow("unknown field 'body'")
    })

    it('requires a one-line title', () => {
        expect(() => webhook.parse({})).toThrow('title is required')
        expect(() => webhook.parse({ title: '  ' })).toThrow('title is required')
        expect(() => webhook.parse({ title: 7 })).toThrow('title must be a string')
        expect(() => webhook.parse({ title: 'a\nb' })).toThrow('title must be one line')
    })

    it('checks the level', () => {
        expect(() => webhook.parse({ title: 'x', level: 'urgent' })).toThrow(
            'level must be one of low, normal, high, critical',
        )
    })

    it('only accepts https links', () => {
        expect(() => webhook.parse({ title: 'x', url: 'http://example.com' })).toThrow('url must be https')
        expect(() => webhook.parse({ title: 'x', url: 'javascript:alert(1)' })).toThrow('url must be https')
        expect(() => webhook.parse({ title: 'x', url: 'not a url' })).toThrow('url must be https')
    })

    it('checks the optional strings', () => {
        expect(() => webhook.parse({ title: 'x', text: 1 })).toThrow('text must be a string')
        expect(() => webhook.parse({ title: 'x', rich: [] })).toThrow('rich must be a string')
        expect(() => webhook.parse({ title: 'x', key: {} })).toThrow('key must be a string')
        expect(() => webhook.parse({ title: 'x', group: false })).toThrow('group must be a string')
        expect(() => webhook.parse({ title: 'x', to: ['a@example.com'] })).toThrow('to must be a string')
    })

    it('rejects recipients that are not email addresses, before any channel sees them', () => {
        for (const to of ['', 'not an address', 'a@typo@example.com', 'ops@例え.jp', 'a@example.com,', 'Doe, Jane <jane@example.com>']) {
            expect(() => webhook.parse({ title: 'x', to })).toThrow('to must be one or more email addresses')
        }
    })
})
