// Present in the current Workers runtime; Wrangler's generated Web Crypto type omits it.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
