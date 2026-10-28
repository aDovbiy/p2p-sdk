/**
 * Keeps a test off the network: `fetch` reaches only the loopback address the tests' stubs listen on. The library
 * sends every request through the global `fetch`, so a request to Steam or to DMarket's real gateway fails here and is
 * recorded, rather than leaving the machine. Import it before anything that sends.
 */
export const refusedHosts: string[] = [];

const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  refusedHosts.push(url.host);
  return Promise.reject(new Error(`a test sent a request off the machine: ${url.host}`));
};
