import { DurableObject } from "cloudflare:workers";

/** The relay's Durable Object; step 3 fills it in. */
export class Relay extends DurableObject<Env> {}

export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
