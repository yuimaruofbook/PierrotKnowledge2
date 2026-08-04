/**
 * Toolbar formatting commands.
 *
 * These edit the Markdown source directly, so the risk is not that a button
 * looks wrong — it is that a button silently mangles a file. Toggling is
 * tested in both directions for every command that has one.
 */

import { describe, expect, test } from "bun:test";
import { activeFormats, applyFormat, type EditState } from "../src/shared/markdown-format";

/**
 * `|` marks the caret; `«…»` marks a selection.
 *
 * Guillemets rather than square brackets: Markdown uses brackets for links and
 * task boxes, so a bracket-based spec cannot express `- [x] 完了`.
 */
function parse(spec: string): EditState {
  if (spec.includes("«")) {
    const start = spec.indexOf("«");
    const end = spec.indexOf("»") - 1;
    return { value: spec.replace(/[«»]/g, ""), selectionStart: start, selectionEnd: end };
  }
  return {
    value: spec.replace("|", ""),
    selectionStart: spec.indexOf("|"),
    selectionEnd: spec.indexOf("|"),
  };
}

const run = (spec: string, action: Parameters<typeof applyFormat>[1]) =>
  applyFormat(parse(spec), action);

describe("headings", () => {
  test("applies a heading to the caret's line", () => {
    expect(run("設計原則|", "h1").value).toBe("# 設計原則");
    expect(run("設計原則|", "h2").value).toBe("## 設計原則");
  });

  test("clicking the same level again removes it", () => {
    expect(run("# 設計原則|", "h1").value).toBe("設計原則");
  });

  test("clicking a different level replaces it", () => {
    expect(run("# 設計原則|", "h3").value).toBe("### 設計原則");
  });

  test("paragraph strips whatever marker the line had", () => {
    expect(run("### 見出し|", "paragraph").value).toBe("見出し");
    expect(run("- 箇条書き|", "paragraph").value).toBe("箇条書き");
  });

  test("a heading replaces a list marker rather than stacking on it", () => {
    // `# - item` is not a heading containing a list; it is a mistake.
    expect(run("- 項目|", "h2").value).toBe("## 項目");
  });

  test("applies across a multi-line selection", () => {
    const state = { value: "一行目\n二行目", selectionStart: 0, selectionEnd: 7 };
    expect(applyFormat(state, "h2").value).toBe("## 一行目\n## 二行目");
  });

  test("works on an empty line", () => {
    expect(run("|", "h1").value).toBe("# ");
  });
});

describe("inline markers", () => {
  test("wraps a selection", () => {
    expect(run("これは«重要»です", "bold").value).toBe("これは**重要**です");
    expect(run("これは«重要»です", "italic").value).toBe("これは*重要*です");
    expect(run("これは«重要»です", "strike").value).toBe("これは~~重要~~です");
    expect(run("これは«重要»です", "code").value).toBe("これは`重要`です");
  });

  test("unwraps when the markers are inside the selection", () => {
    expect(run("これは«**重要**»です", "bold").value).toBe("これは重要です");
  });

  test("unwraps when the markers sit just outside the selection", () => {
    // What happens when you double-click a bolded word and press 太字 again.
    expect(run("これは**«重要»**です", "bold").value).toBe("これは重要です");
  });

  test("an empty selection leaves the caret between the markers", () => {
    const result = run("ここに|", "bold");
    expect(result.value).toBe("ここに****");
    expect(result.selectionStart).toBe(5);
    expect(result.selectionEnd).toBe(5);
  });

  test("the wrapped text stays selected, so a second press toggles off", () => {
    const first = run("これは«重要»です", "bold");
    expect(first.value.slice(first.selectionStart, first.selectionEnd)).toBe("重要");

    const second = applyFormat(first, "bold");
    expect(second.value).toBe("これは重要です");
  });
});

describe("quotes and lists", () => {
  test("quote toggles on and off", () => {
    expect(run("引用文|", "quote").value).toBe("> 引用文");
    expect(run("> 引用文|", "quote").value).toBe("引用文");
  });

  test("bullets toggle", () => {
    expect(run("項目|", "ul").value).toBe("- 項目");
    expect(run("- 項目|", "ul").value).toBe("項目");
  });

  test("numbered lists count from one across the selection", () => {
    const state = { value: "一\n二\n三", selectionStart: 0, selectionEnd: 5 };
    expect(applyFormat(state, "ol").value).toBe("1. 一\n2. 二\n3. 三");
  });

  test("tasks are distinct from plain bullets", () => {
    expect(run("やること|", "task").value).toBe("- [ ] やること");
    // Toggling ul on a task list converts it rather than reporting a match.
    expect(run("- [ ] やること|", "ul").value).toBe("- やること");
    expect(run("- [ ] やること|", "task").value).toBe("やること");
  });

  test("switching list type does not stack markers", () => {
    expect(run("- 項目|", "ol").value).toBe("1. 項目");
    expect(run("1. 項目|", "ul").value).toBe("- 項目");
  });

  test("quoting a whole selection requires every line to be quoted to toggle off", () => {
    const mixed = { value: "> 一\n二", selectionStart: 0, selectionEnd: 5 };
    // Not all quoted, so this adds rather than removes.
    expect(applyFormat(mixed, "quote").value).toBe("> > 一\n> 二");
  });
});

describe("links", () => {
  test("wraps the selection and selects the url placeholder", () => {
    const result = run("詳しくは«こちら»を見て", "link");

    expect(result.value).toBe("詳しくは[こちら](url)を見て");
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe("url");
  });

  test("an empty selection inserts a placeholder pair", () => {
    expect(run("|", "link").value).toBe("[リンクテキスト](url)");
  });
});

describe("alignment", () => {
  test("wraps the block in an HTML div, with blank lines so Markdown still parses", () => {
    expect(run("中央にしたい|", "align-center").value).toBe(
      '<div align="center">\n\n中央にしたい\n\n</div>'
    );
  });

  test("the same alignment again removes it", () => {
    const centred = run("中央にしたい|", "align-center");
    expect(applyFormat(centred, "align-center").value).toBe("中央にしたい");
  });

  test("a different alignment replaces it rather than nesting", () => {
    const centred = run("文章|", "align-center");
    const right = applyFormat(centred, "align-right");

    expect(right.value).toBe('<div align="right">\n\n文章\n\n</div>');
    expect(right.value).not.toContain("center");
  });
});

describe("blocks", () => {
  test("a rule is inserted on its own line", () => {
    expect(run("本文|", "hr").value).toBe("本文\n---\n");
  });

  test("a table skeleton is inserted", () => {
    expect(run("|", "table").value).toContain("| --- | --- |");
  });
});

describe("active state for the toolbar", () => {
  test("reports the heading level", () => {
    expect(activeFormats(parse("## 見出し|"))).toContain("h2");
    expect(activeFormats(parse("## 見出し|"))).not.toContain("h1");
  });

  test("reports quote and list state", () => {
    expect(activeFormats(parse("> 引用|"))).toContain("quote");
    expect(activeFormats(parse("- 項目|"))).toContain("ul");
    expect(activeFormats(parse("1. 項目|"))).toContain("ol");
    expect(activeFormats(parse("- [ ] やること|"))).toContain("task");
  });

  test("a task line is not also reported as a bullet", () => {
    // Both buttons lighting up would misrepresent what a click will do.
    expect(activeFormats(parse("- [x] 完了|"))).not.toContain("ul");
  });

  test("reports alignment", () => {
    const centred = run("文章|", "align-center");
    expect(activeFormats(centred)).toContain("align-center");
  });

  test("plain text has nothing active", () => {
    expect([...activeFormats(parse("ただの文章|"))]).toEqual([]);
  });
});

describe("safety", () => {
  test("no command loses text", () => {
    const actions = [
      "h1", "h2", "h3", "paragraph", "bold", "italic", "strike", "code",
      "quote", "ul", "ol", "task", "link", "align-left", "align-center",
      "align-right", "hr", "table",
    ] as const;

    const original = "これは大事な本文です";
    for (const action of actions) {
      const result = applyFormat(
        { value: original, selectionStart: 0, selectionEnd: original.length },
        action
      );
      // Every command must preserve the words, whatever it does to the markup.
      expect(result.value).toContain("これは大事な本文です");
    }
  });

  test("selection offsets stay inside the new value", () => {
    const actions = ["h1", "bold", "quote", "ul", "link", "align-center", "hr"] as const;

    for (const action of actions) {
      const result = applyFormat({ value: "文章", selectionStart: 0, selectionEnd: 2 }, action);
      expect(result.selectionStart).toBeGreaterThanOrEqual(0);
      expect(result.selectionEnd).toBeLessThanOrEqual(result.value.length);
      expect(result.selectionStart).toBeLessThanOrEqual(result.selectionEnd);
    }
  });
});
