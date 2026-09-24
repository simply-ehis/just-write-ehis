import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { BibleFact, BibleMention } from "$lib/api";

export interface StoryMemoryContradictionValue {
  value: string;
  mentions: BibleMention[];
}

export interface StoryMemoryContradiction {
  attributeKey: string;
  values: StoryMemoryContradictionValue[];
}

export interface StoryMemoryView {
  fact: BibleFact;
  appearances: BibleMention[];
  contradictions: StoryMemoryContradiction[];
}

export interface StoryMemoryData {
  facts: BibleFact[];
  mentions: BibleMention[];
}

export const storyMemoryDataEffect = StateEffect.define<StoryMemoryData | null>();

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function buildContradictions(factKey: string, mentions: BibleMention[]): StoryMemoryContradiction[] {
  const groups = new Map<string, Map<string, StoryMemoryContradictionValue>>();
  for (const mention of mentions) {
    if (normalize(mention.fact_key) !== normalize(factKey) || !mention.attribute_key || !mention.attribute_value) continue;
    const attributeKey = normalize(mention.attribute_key);
    const valueKey = normalize(mention.attribute_value);
    const values = groups.get(attributeKey) ?? new Map<string, StoryMemoryContradictionValue>();
    const value = values.get(valueKey) ?? { value: mention.attribute_value, mentions: [] };
    value.mentions.push(mention);
    values.set(valueKey, value);
    groups.set(attributeKey, values);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([attributeKey, values]) => ({ attributeKey, values: [...values.values()] }));
}

export function buildStoryMemoryViews(data: StoryMemoryData | null): StoryMemoryView[] {
  if (!data) return [];
  return data.facts.map((fact) => {
    const appearances = data.mentions.filter((mention) => normalize(mention.fact_key) === normalize(fact.key));
    return { fact, appearances, contradictions: buildContradictions(fact.key, appearances) };
  });
}

function findEntityAt(view: EditorView, pos: number, data: StoryMemoryData | null): StoryMemoryView | null {
  if (!data) return null;
  const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length)));
  const offset = Math.max(0, Math.min(pos - line.from, line.text.length));
  const source = line.text.toLocaleLowerCase();
  const facts = [...data.facts].sort((a, b) => b.key.length - a.key.length);
  for (const fact of facts) {
    const key = fact.key.toLocaleLowerCase();
    if (!key) continue;
    let start = source.indexOf(key);
    while (start !== -1) {
      const end = start + key.length;
      if (start <= offset && offset <= end) {
        const appearances = data.mentions.filter((mention) => normalize(mention.fact_key) === normalize(fact.key));
        return { fact, appearances, contradictions: buildContradictions(fact.key, appearances) };
      }
      start = source.indexOf(key, start + key.length);
    }
  }
  return null;
}

export function createStoryMemoryExtension(options: {
  onHover: (view: StoryMemoryView | null, position: { x: number; y: number }) => void;
}): Extension {
  const field = StateField.define<StoryMemoryData | null>({
    create: () => null,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(storyMemoryDataEffect)) return effect.value;
      }
      return value;
    },
  });
  let activeKey: string | null = null;
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.state.field(field) !== update.startState.field(field)) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const data = view.state.field(field);
      if (!data) return Decoration.none;
      const text = view.state.doc.toString().toLocaleLowerCase();
      const ranges: { from: number; to: number }[] = [];
      for (const fact of [...data.facts].sort((a, b) => b.key.length - a.key.length)) {
        const key = fact.key.toLocaleLowerCase();
        if (!key) continue;
        let start = text.indexOf(key);
        while (start !== -1) {
          const end = start + key.length;
          if (!ranges.some((range) => start < range.to && range.from < end)) ranges.push({ from: start, to: end });
          start = text.indexOf(key, end);
        }
      }
      return Decoration.set(
        ranges
          .sort((a, b) => a.from - b.from)
          .map((range) => Decoration.mark({ class: "story-memory-known" }).range(range.from, range.to)),
        true,
      );
    }
  }, { decorations: (value) => value.decorations });
  const handlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) {
        activeKey = null;
        options.onHover(null, { x: event.clientX, y: event.clientY });
        return false;
      }
      const found = findEntityAt(view, pos, view.state.field(field));
      const key = found ? normalize(found.fact.key) : null;
      if (key !== activeKey) {
        activeKey = key;
        options.onHover(found, { x: event.clientX, y: event.clientY });
      } else if (found) {
        options.onHover(found, { x: event.clientX, y: event.clientY });
      }
      return false;
    },
  });
  return [field, plugin, handlers];
}

export function setStoryMemoryData(view: EditorView | null, data: StoryMemoryData | null): void {
  if (!view) return;
  view.dispatch({ effects: storyMemoryDataEffect.of(data) });
}
