import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../../../src/core/paths.ts";
import type { LaunchPlan } from "../../../src/features/session/harness/types.ts";
import { run } from "../../../src/main.ts";
import { fakeSecrets, tempHome, testDeps } from "../../helpers.ts";

/** A data dir installed by the real `tars install` from fixture skills, plus a launcher that records plans. */
export async function installedHome(soul = "I am tars.\n", memory = "- user likes tea\n") {
  const home = tempHome();
  writeFileSync(join(home, "soul.src"), soul);
  writeFileSync(join(home, "memory.src"), memory);
  const env = { HOME: home, PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fake-bus" };
  const installer = testDeps({
    env,
    embedded: async () => [{ path: "alpha/SKILL.md", bytes: new TextEncoder().encode("alpha") }],
  });
  const code = await run(
    ["install", "--soul", join(home, "soul.src"), "--memory", join(home, "memory.src")],
    installer,
  );
  if (code !== 0) throw new Error(`install failed: ${installer.io.stderr.join("\n")}`);

  const plans: LaunchPlan[] = [];
  const secrets = fakeSecrets({ "claude-oauth-token": "sk-ant-oat01-FAKE" });
  const deps = testDeps({
    env,
    secrets,
    launch: async (plan) => {
      plans.push(plan);
      return 7;
    },
  });
  return { home, env, deps, plans, secrets, paths: resolvePaths(env) };
}
