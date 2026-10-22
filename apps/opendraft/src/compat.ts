// WebKit/Safari builds without ReadableStream async iteration break PDF.js getTextContent
// (`for await (… of stream)`). Standard-conformant fallback; native support is left untouched.
type IterableStream = ReadableStream & { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
const proto = ReadableStream.prototype as IterableStream;
if (typeof proto[Symbol.asyncIterator] !== 'function') {
  Object.defineProperty(proto, Symbol.asyncIterator, {
    configurable: true, writable: true,
    value: async function* (this: ReadableStream) {
      const reader = this.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; }
      } finally { reader.releaseLock(); }
    },
  });
}
export {};
