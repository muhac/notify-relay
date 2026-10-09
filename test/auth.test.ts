import { describe, expect, it } from 'vitest'
import { authenticate, constantTimeEqual } from '../src/core/auth'

const env = {
    TOKEN_GITHUB: 'nr_github',
    TOKEN_LAPTOP_MAC: 'nr_old nr_new',
    LOKI_TOKEN: 'nr_not_a_source',
    LOKI_USER: '123456',
}

describe('authenticate', () => {
    it('names the source after the secret that holds the token', () => {
        expect(authenticate('Bearer nr_github', env)).toBe('github')
        expect(authenticate('Bearer nr_new', env)).toBe('laptop-mac')
    })

    it('accepts every token in a space-separated secret, so rotation can overlap', () => {
        expect(authenticate('Bearer nr_old', env)).toBe('laptop-mac')
    })

    it('rejects anything else', () => {
        expect(authenticate(null, env)).toBeUndefined()
        expect(authenticate('', env)).toBeUndefined()
        expect(authenticate('Bearer ', env)).toBeUndefined()
        expect(authenticate('Bearer nr_wrong', env)).toBeUndefined()
        expect(authenticate('Basic nr_github', env)).toBeUndefined()
        expect(authenticate('nr_github', env)).toBeUndefined()
    })

    it('only trusts TOKEN_ secrets', () => {
        expect(authenticate('Bearer nr_not_a_source', env)).toBeUndefined()
        expect(authenticate('Bearer 123456', env)).toBeUndefined()
    })
})

describe('constantTimeEqual', () => {
    it('compares whole strings', () => {
        expect(constantTimeEqual('nr_abc', 'nr_abc')).toBe(true)
        expect(constantTimeEqual('nr_abc', 'nr_abd')).toBe(false)
        expect(constantTimeEqual('nr_abc', 'nr_ab')).toBe(false)
        expect(constantTimeEqual('', 'nr_abc')).toBe(false)
    })
})
