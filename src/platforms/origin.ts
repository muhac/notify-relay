// For platforms that build the Request themselves: the relay reads only the path and query, so the origin
// is fixed rather than taken from Host, which the client controls
export const ORIGIN = 'http://relay.invalid'
