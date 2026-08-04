/**
 * The SkillSpace panel.
 *
 * One job: show what skills exist and what each costs to load. Cost is
 * displayed because it is the thing a user is otherwise blind to — a skill
 * that is never opened is nearly free, and one that is opened every time is
 * not.
 *
 * Connecting a runtime used to live here too, on two extra tabs. It has moved
 * to the connections panel, where the other half of the same question already
 * was: "what is this app talking to?" is one question, and answering it in two
 * places meant neither screen ever showed the whole answer.
 */

import type { SkillSummary } from "../../shared/okf/skill";
import { clear, el } from "../dom";

export interface SkillsPanelOptions {
  root: HTMLElement;
  body: HTMLElement;
  closeButton: HTMLElement;

  listSkills: () => Promise<SkillSummary[]>;
  findSkill: (task: string) => Promise<{
    ranked: Array<{ name: string; description: string; score: number; matched: string[] }>;
    confidence: "high" | "medium" | "low";
    topTokens: number;
  }>;
  openSkillFile: (name: string) => Promise<string>;
  createSkill: (name: string, description: string) => Promise<{ path: string }>;

  onOpenFile: (path: string) => void;
  onNotice: (message: string) => void;
  onError: (error: unknown) => void;
}

const CONFIDENCE_LABEL = {
  high: "確度: 高",
  medium: "確度: 中",
  low: "確度: 低（説明を見比べてください）",
} as const;

export class SkillsPanel {
  private skills: SkillSummary[] = [];

  constructor(private readonly ui: SkillsPanelOptions) {
    ui.closeButton.addEventListener("click", () => this.close());
    ui.root.addEventListener("mousedown", (event) => {
      if (event.target === ui.root) this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.root.hidden) this.close();
    });
  }

  async open(): Promise<void> {
    this.ui.root.hidden = false;
    await this.refresh();
  }

  close(): void {
    this.ui.root.hidden = true;
  }

  private async refresh(): Promise<void> {
    try {
      this.skills = await this.ui.listSkills();
      this.renderSkills();
    } catch (error) {
      this.ui.onError(error);
    }
  }

  // ---- skills ----

  private renderSkills(): void {
    const body = this.ui.body;
    clear(body);

    body.appendChild(
      el("p", {
        className: "conn-hint",
        text:
          "エージェントは常時「名前と説明」だけを読み、必要と判断したスキルの本文だけを展開します。下の推定トークンは、その 1 件を開いたときの追加コストです。",
      })
    );

    // The selection tester: type a request, see what would be chosen and what
    // it would cost, without spending anything.
    const tester = el("div", { className: "skill-tester" });
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "依頼文を入れて、どのスキルが選ばれるか試す…";
    tester.appendChild(input);

    const verdict = el("div", { className: "skill-verdict" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.preview(input.value, verdict), 250);
    });
    tester.appendChild(verdict);
    body.appendChild(tester);

    if (this.skills.length === 0) {
      body.appendChild(
        el("div", {
          className: "empty",
          text: "skills/ にスキルがありません。下のボタンで作成できます。",
        })
      );
    }

    for (const skill of this.skills) {
      const row = el("div", { className: "skill-row" });

      const head = el("div", { className: "skill-head" });
      head.appendChild(el("span", { className: "skill-name", text: skill.name }));
      head.appendChild(el("span", { className: "badge", text: `本文 ~${skill.bodyTokens} tok` }));
      for (const tag of skill.tags) {
        head.appendChild(el("span", { className: "badge", text: `#${tag}` }));
      }
      row.appendChild(head);

      row.appendChild(el("p", { className: "skill-desc", text: skill.description }));

      if (skill.resources.length) {
        row.appendChild(
          el("div", {
            className: "skill-resources",
            text: `追加ファイル: ${skill.resources.join(", ")}`,
          })
        );
      }

      const edit = el("button", { className: "btn", text: "SKILL.md を開く" });
      edit.type = "button";
      edit.addEventListener("click", () => void this.openFile(skill.name));
      row.appendChild(edit);

      body.appendChild(row);
    }

    const create = el("button", { className: "btn btn-primary", text: "＋ 新しいスキル" });
    create.type = "button";
    create.addEventListener("click", () => void this.create());

    const footer = el("div", { className: "conn-actions" });
    footer.appendChild(create);
    body.appendChild(footer);
  }

  private async preview(task: string, into: HTMLElement): Promise<void> {
    clear(into);
    if (!task.trim()) return;

    try {
      const result = await this.ui.findSkill(task);
      if (result.ranked.length === 0) {
        into.appendChild(el("div", { className: "empty", text: "合うスキルはありません" }));
        return;
      }

      into.appendChild(
        el("div", {
          className: "skill-confidence",
          text: `${CONFIDENCE_LABEL[result.confidence]} · 上位を開くと ~${result.topTokens} tok`,
        })
      );

      for (const [index, hit] of result.ranked.entries()) {
        into.appendChild(
          el("div", {
            className: `skill-hit${index === 0 ? " top" : ""}`,
            text: `${index + 1}. ${hit.name} (${hit.score}) — 一致: ${hit.matched.join(", ")}`,
          })
        );
      }
    } catch (error) {
      this.ui.onError(error);
    }
  }

  private async openFile(name: string): Promise<void> {
    try {
      this.ui.onOpenFile(await this.ui.openSkillFile(name));
      this.close();
    } catch (error) {
      this.ui.onError(error);
    }
  }

  private async create(): Promise<void> {
    const name = prompt("スキル名（英小文字・数字・ハイフン）", "my-skill");
    if (!name) return;
    const description = prompt(
      "説明 — これだけが常時読まれます。「どんなときに使うか」を書いてください",
      ""
    );
    if (!description) return;

    try {
      const { path } = await this.ui.createSkill(name.trim(), description.trim());
      this.ui.onOpenFile(path);
      this.close();
    } catch (error) {
      this.ui.onError(error);
    }
  }
}
