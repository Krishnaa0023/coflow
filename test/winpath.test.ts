import { test } from "node:test";
import assert from "node:assert/strict";
import { portablePath, executableNames } from "../src/core/paths.js";
import { isCoflowHookCommand, pruneStaleCoflowHooks } from "../src/cli/init.js";

test("portablePath converts Windows backslashes to forward slashes", () => {
  assert.equal(
    portablePath("C:\\Users\\ivan.bonanno\\AppData\\Roaming\\npm\\node_modules\\@krish0023\\coflow\\dist\\cli\\main.js"),
    "C:/Users/ivan.bonanno/AppData/Roaming/npm/node_modules/@krish0023/coflow/dist/cli/main.js",
  );
});

test("portablePath leaves a POSIX path unchanged", () => {
  assert.equal(portablePath("/usr/local/lib/node_modules/coflow/dist/cli/main.js"),
    "/usr/local/lib/node_modules/coflow/dist/cli/main.js");
});

test("executableNames on POSIX is just the bare command", () => {
  assert.deepEqual(executableNames("coflow", "linux"), ["coflow"]);
  assert.deepEqual(executableNames("coflow", "darwin"), ["coflow"]);
});

test("executableNames on Windows includes the npm .cmd/.exe shims", () => {
  const names = executableNames("coflow", "win32", ".COM;.EXE;.BAT;.CMD");
  assert.ok(names.includes("coflow"), "bare name still tried");
  assert.ok(names.includes("coflow.CMD"), "npm global bin is coflow.cmd");
  assert.ok(names.includes("coflow.EXE"));
  assert.ok(names.includes("coflow.BAT"));
});

test("executableNames tolerates PATHEXT entries without a leading dot", () => {
  const names = executableNames("coflow", "win32", "EXE;CMD");
  assert.ok(names.includes("coflow.EXE"));
  assert.ok(names.includes("coflow.CMD"));
});

test("isCoflowHookCommand recognises coflow hooks across modes", () => {
  assert.equal(isCoflowHookCommand("coflow hook session-start"), true);
  assert.equal(isCoflowHookCommand("node C:/Users/x/coflow/dist/cli/main.js hook stop"), true);
  assert.equal(isCoflowHookCommand("npx -y @krish0023/coflow hook post-tool-use"), true);
  // Not coflow / not a hook
  assert.equal(isCoflowHookCommand("eslint --fix"), false);
  assert.equal(isCoflowHookCommand("coflow chat"), false);
  assert.equal(isCoflowHookCommand(undefined), false);
});

test("pruneStaleCoflowHooks heals a broken config and preserves foreign hooks", () => {
  const settings: Record<string, unknown> = {
    hooks: {
      // A broken absolute-path coflow hook from an older/buggy install
      SessionStart: [
        { hooks: [{ type: "command", command: "node C:\\Users\\me\\coflow\\dist\\cli\\main.js hook session-start" }] },
      ],
      // A non-coflow hook the user added — must be kept
      PreToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: "my-linter --check" }] },
      ],
    },
  };
  pruneStaleCoflowHooks(settings);
  const hooks = settings.hooks as Record<string, unknown[]>;
  assert.equal(hooks.SessionStart, undefined, "stale coflow hook removed (event emptied)");
  assert.ok(hooks.PreToolUse, "foreign hook preserved");
  assert.equal((hooks.PreToolUse[0] as any).hooks[0].command, "my-linter --check");
});
