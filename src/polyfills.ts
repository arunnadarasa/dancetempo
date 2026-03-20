/**
 * @x402/extensions (and deps) expect Node's `Buffer` in the browser.
 */
import { Buffer } from 'buffer'

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer }
if (g.Buffer === undefined) {
  g.Buffer = Buffer
}
