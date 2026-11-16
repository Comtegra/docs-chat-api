import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Powierzchnia AI/czatu (components/ai, components/ui, components/chat, pages/chat.js, lib/chat,
// lib/admin/statusTones) jest pisana z `// @ts-check` — ten test egzekwuje, że tsc (strict,
// tsconfig.ai.json) przechodzi, a nie tylko że komentarz istnieje. Pliki bez @ts-check w tym
// zakresie (np. useCgcChat.js) są sprawdzane pośrednio przez typy zwracane do konsumentów.

test("tsc -p tsconfig.ai.json passes (strict typecheck of the AI/chat surface)", { timeout: 180000 }, () => {
  const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.ai.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `tsc failed:\n${result.stdout}\n${result.stderr}`);
});
