// Vite's ?raw import, for a test that reads wrangler.jsonc; the worker's types have no Vite.
declare module "*?raw" {
  const text: string;
  export default text;
}
