import assert from "node:assert/strict";
import test from "node:test";

import { extractTrailingMemoryCitation, parseMemoryCitation } from "./memory-citation.ts";

test("extracts a strict trailing memory citation without leaving machine XML in the message", () => {
  const result = extractTrailingMemoryCitation(`From prior project context.
<oai-mem-citation>
<citation_entries>
MEMORY.md:1-3|note=[prior Agent Manager project context]
</citation_entries>
<rollout_ids>
019fcbd5-7a38-7c31-a5f7-e199f5b06f4e
</rollout_ids>
</oai-mem-citation>`);

  assert.equal(result.text, "From prior project context.");
  assert.deepEqual(result.memoryCitation, {
    entries: [{
      path: "MEMORY.md",
      lineStart: 1,
      lineEnd: 3,
      note: "prior Agent Manager project context",
    }],
    rolloutIds: ["019fcbd5-7a38-7c31-a5f7-e199f5b06f4e"],
  });
});

test("keeps malformed or non-trailing citation markup as ordinary visible text", () => {
  const malformed = "Answer\n<oai-mem-citation>bad</oai-mem-citation>";
  assert.deepEqual(extractTrailingMemoryCitation(malformed), {
    text: malformed,
    memoryCitation: null,
  });
  const quoted = "Example <oai-mem-citation> is documentation, not metadata.";
  assert.deepEqual(extractTrailingMemoryCitation(quoted), {
    text: quoted,
    memoryCitation: null,
  });
});

test("accepts the structured App Server citation shape and rejects unsafe fields", () => {
  assert.deepEqual(parseMemoryCitation({
    entries: [{ path: "MEMORY.md", lineStart: 5, lineEnd: 7, note: "decision context" }],
    rolloutIds: [],
  }), {
    entries: [{ path: "MEMORY.md", lineStart: 5, lineEnd: 7, note: "decision context" }],
    rolloutIds: [],
  });
  assert.equal(parseMemoryCitation({
    entries: [{ path: "MEMORY.md", lineStart: 7, lineEnd: 5, note: "invalid range" }],
    rolloutIds: [],
  }), null);
});

test("accepts an empty rollout-id section", () => {
  const result = extractTrailingMemoryCitation(`Answer.
<oai-mem-citation>
<citation_entries>
MEMORY.md:1-1|note=[context]
</citation_entries>
<rollout_ids>
</rollout_ids>
</oai-mem-citation>`);
  assert.equal(result.text, "Answer.");
  assert.deepEqual(result.memoryCitation?.rolloutIds, []);
});
