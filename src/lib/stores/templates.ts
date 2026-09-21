import { writable, derived } from "svelte/store";
import { get } from "svelte/store";
import { settings } from "./settings";
import { api } from "$lib/api";

export interface Template {
  id: string;
  name: string;
  description: string;
  content: string;
  variables: TemplateVariable[];
  workspace: string;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateVariable {
  name: string;
  label: string;
  type: "text" | "date" | "select" | "textarea";
  default?: string;
  options?: string[];
  required: boolean;
}

export interface Snippet {
  id: string;
  trigger: string;
  expansion: string;
  description: string;
  workspace: string | "global";
  createdAt: number;
}

const builtinTemplates: Template[] = [
  {
    id: "daily-note",
    name: "Daily Note",
    description: "A structured daily journal entry",
    content: `# {{date}}

## Morning
- Gratitude:
- Intention:
- Sleep quality:

## Tasks
- [ ] 
- [ ] 
- [ ] 

## Notes

---

## Evening
- Wins:
- Learnings:
- Tomorrow's focus:`,
    variables: [
      { name: "date", label: "Date", type: "date", default: "", required: true },
    ],
    workspace: "logs",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "meeting-notes",
    name: "Meeting Notes",
    description: "Structured meeting template with action items",
    content: `# {{title}} — {{date}}

**Attendees:** {{attendees}}
**Duration:** {{duration}}

## Agenda
{{agenda}}

## Discussion

## Decisions
- 

## Action Items
- [ ] {{actionItem}} — @{{assignee}} — Due: {{dueDate}}

## Next Steps
`,
    variables: [
      { name: "title", label: "Meeting Title", type: "text", default: "", required: true },
      { name: "date", label: "Date", type: "date", default: "", required: true },
      { name: "attendees", label: "Attendees", type: "textarea", default: "", required: false },
      { name: "duration", label: "Duration", type: "text", default: "30 min", required: false },
      { name: "agenda", label: "Agenda", type: "textarea", default: "", required: false },
      { name: "actionItem", label: "Action Item", type: "text", default: "", required: false },
      { name: "assignee", label: "Assignee", type: "text", default: "", required: false },
      { name: "dueDate", label: "Due Date", type: "date", default: "", required: false },
    ],
    workspace: "projects",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "project-brief",
    name: "Project Brief",
    description: "One-page project overview",
    content: `# {{projectName}}

**Status:** {{status}} | **Owner:** {{owner}} | **Started:** {{startDate}}

## Problem
{{problem}}

## Solution
{{solution}}

## Success Metrics
- {{metric1}}
- {{metric2}}

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
|      |            |        |            |

## Timeline
| Phase | Dates | Deliverable |
|-------|-------|-------------|
|       |       |             |

## Resources
- Budget:
- Team:
- Tools:
`,
    variables: [
      { name: "projectName", label: "Project Name", type: "text", default: "", required: true },
      { name: "status", label: "Status", type: "select", default: "planning", options: ["planning", "active", "on hold", "done"], required: true },
      { name: "owner", label: "Owner", type: "text", default: "", required: true },
      { name: "startDate", label: "Start Date", type: "date", default: "", required: true },
      { name: "problem", label: "Problem Statement", type: "textarea", default: "", required: true },
      { name: "solution", label: "Proposed Solution", type: "textarea", default: "", required: true },
      { name: "metric1", label: "Metric 1", type: "text", default: "", required: false },
      { name: "metric2", label: "Metric 2", type: "text", default: "", required: false },
    ],
    workspace: "projects",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "literature-note",
    name: "Literature Note",
    description: "Atomic note for Zettelkasten-style reading",
    content: `# {{title}}

**Source:** {{source}}
**Author:** {{author}}
**Date read:** {{date}}
**Tags:** {{tags}}

## Key Ideas
{{keyIdeas}}

## Quotes
> {{quote}}

## Connections
- [[Related note 1]]
- [[Related note 2]]

## Questions
- {{question}}
`,
    variables: [
      { name: "title", label: "Title", type: "text", default: "", required: true },
      { name: "source", label: "Source (book/article/paper)", type: "text", default: "", required: true },
      { name: "author", label: "Author", type: "text", default: "", required: false },
      { name: "date", label: "Date", type: "date", default: "", required: true },
      { name: "tags", label: "Tags", type: "text", default: "", required: false },
      { name: "keyIdeas", label: "Key Ideas", type: "textarea", default: "", required: true },
      { name: "quote", label: "Notable Quote", type: "textarea", default: "", required: false },
      { name: "question", label: "Open Question", type: "text", default: "", required: false },
    ],
    workspace: "write",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const builtinSnippets: Snippet[] = [
  { id: "sig", trigger: ";;sig", expansion: "\n---\n{{date}}", description: "Signature with date", workspace: "global", createdAt: Date.now() },
  { id: "todo", trigger: ";;todo", expansion: "- [ ] ", description: "Checkbox", workspace: "global", createdAt: Date.now() },
  { id: "date", trigger: ";;date", expansion: "{{date}}", description: "Current date", workspace: "global", createdAt: Date.now() },
  { id: "time", trigger: ";;time", expansion: "{{time}}", description: "Current time", workspace: "global", createdAt: Date.now() },
  { id: "link", trigger: ";;link", expansion: "[[]]", description: "Wikilink", workspace: "global", createdAt: Date.now() },
  { id: "tag", trigger: ";;tag", expansion: "#", description: "Hashtag", workspace: "global", createdAt: Date.now() },
];

const TEMPLATES_KEY = "jw-templates";
const SNIPPETS_KEY = "jw-snippets";

function loadTemplates(): Template[] {
  try {
    const stored = localStorage.getItem(TEMPLATES_KEY);
    if (stored) return JSON.parse(stored);
  } catch { }
  return builtinTemplates;
}

function loadSnippets(): Snippet[] {
  try {
    const stored = localStorage.getItem(SNIPPETS_KEY);
    if (stored) return JSON.parse(stored);
  } catch { }
  return builtinSnippets;
}

export const templates = writable<Template[]>(loadTemplates());
export const snippets = writable<Snippet[]>(loadSnippets());

templates.subscribe((val) => {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(val)); } catch { }
});

snippets.subscribe((val) => {
  try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(val)); } catch { }
});

export function resolveVariables(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  // Auto-fill date/time if not provided
  const now = new Date();
  result = result.replace(/\{\{date\}\}/g, now.toISOString().split("T")[0]);
  result = result.replace(/\{\{time\}\}/g, now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  result = result.replace(/\{\{datetime\}\}/g, now.toISOString().replace("T", " ").slice(0, 16));
  return result;
}

export function getTemplatesForWorkspace(workspace: string): Template[] {
  return get(templates).filter((t) => t.workspace === workspace || t.workspace === "global");
}

export function getSnippetsForWorkspace(workspace: string): Snippet[] {
  return get(snippets).filter((s) => s.workspace === workspace || s.workspace === "global");
}

export async function createDocFromTemplate(templateId: string, variables: Record<string, string>): Promise<string | null> {
  const template = get(templates).find((t) => t.id === templateId);
  if (!template) return null;

  const content = resolveVariables(template.content, variables);
  const title = resolveVariables(template.name, variables);

  try {
    const doc = await api.docCreate(template.workspace, "markdown", title, undefined, content);
    return doc.id;
  } catch (e) {
    console.error("Failed to create doc from template:", e);
    return null;
  }
}

export function expandSnippet(trigger: string, workspace: string): string | null {
  const snippet = get(snippets).find((s) => s.trigger === trigger && (s.workspace === workspace || s.workspace === "global"));
  if (!snippet) return null;
  return resolveVariables(snippet.expansion, {});
}