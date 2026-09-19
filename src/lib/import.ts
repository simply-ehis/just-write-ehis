/**
 * Import utilities for Obsidian, Notion, and other formats.
 */

export interface ImportOptions {
  source?: 'obsidian' | 'notion' | 'markdown' | 'json' | 'zip';
  vaultPath?: string;
  files?: File[];
  targetWorkspace?: string;
  includeAttachments?: boolean;
  frontmatterMapping?: Record<string, string>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  documents: Array<{ id: string; title: string; workspace: string }>;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const fmRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(fmRegex);
  if (!match) return { frontmatter: {}, body: content };
  
  try {
    const frontmatter = JSON.parse('{' + match[1].replace(/(\w+):\s*/g, '"$1": ').replace(/'/g, '"') + '}');
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function convertNotionBlocks(blocks: any[]): string {
  let markdown = '';
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        markdown += block.paragraph?.rich_text?.map((t: any) => t.plain_text).join('') + '\n\n';
        break;
      case 'heading_1':
        markdown += '# ' + block.heading_1?.rich_text?.map((t: any) => t.plain_text).join('') + '\n\n';
        break;
      case 'heading_2':
        markdown += '## ' + block.heading_2?.rich_text?.map((t: any) => t.plain_text).join('') + '\n\n';
        break;
      case 'heading_3':
        markdown += '### ' + block.heading_3?.rich_text?.map((t: any) => t.plain_text).join('') + '\n\n';
        break;
      case 'bulleted_list_item':
        markdown += '- ' + block.bulleted_list_item?.rich_text?.map((t: any) => t.plain_text).join('') + '\n';
        break;
      case 'numbered_list_item':
        markdown += '1. ' + block.numbered_list_item?.rich_text?.map((t: any) => t.plain_text).join('') + '\n';
        break;
      case 'to_do':
        const checked = block.to_do?.checked ? 'x' : ' ';
        markdown += `- [${checked}] ${block.to_do?.rich_text?.map((t: any) => t.plain_text).join('')}\n`;
        break;
      case 'code':
        const lang = block.code?.language || '';
        markdown += `\`\`\`${lang}\n${block.code?.rich_text?.map((t: any) => t.plain_text).join('')}\n\`\`\`\n\n`;
        break;
      case 'quote':
        markdown += '> ' + block.quote?.rich_text?.map((t: any) => t.plain_text).join('') + '\n\n';
        break;
      case 'callout':
        markdown += `> [!${block.callout?.icon?.emoji || 'note'}]\n> ${block.callout?.rich_text?.map((t: any) => t.plain_text).join('')}\n\n`;
        break;
      case 'toggle':
        markdown += `<details><summary>${block.toggle?.rich_text?.map((t: any) => t.plain_text).join('')}</summary>\n\n${convertNotionBlocks(block.toggle?.children || [])}\n</details>\n\n`;
        break;
      case 'divider':
        markdown += '---\n\n';
        break;
      case 'image':
        const url = block.image?.file?.url || block.image?.external?.url;
        if (url) markdown += `![](${url})\n\n`;
        break;
      case 'video':
      case 'file':
      case 'pdf':
        const fileUrl = block[block.type]?.file?.url || block[block.type]?.external?.url;
        if (fileUrl) markdown += `[${block.type}](${fileUrl})\n\n`;
        break;
      case 'bookmark':
        const bookmarkUrl = block.bookmark?.url;
        if (bookmarkUrl) markdown += `[${block.bookmark?.caption?.[0]?.plain_text || 'Link'}](${bookmarkUrl})\n\n`;
        break;
      case 'link_to_page':
        const pageId = block.link_to_page?.page_id;
        if (pageId) markdown += `[[page:${pageId}]]\n\n`;
        break;
      case 'synced_block':
        markdown += convertNotionBlocks(block.synced_block?.children || []);
        break;
      case 'table':
      case 'table_row':
        // Tables are complex, skip for now
        break;
      default:
        break;
    }
  }
  return markdown;
}

export async function importObsidianVault(vaultPath: string, options: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [], documents: [] };
  
  // In a real implementation, this would read from the filesystem
  // For now, return a mock result
  return result;
}

export async function importNotionExport(zipFile: File, options: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [], documents: [] };
  
  try {
    const zip = await readZip(zipFile);
    
    // Find all markdown files in the zip
    const markdownFiles = Object.keys(zip).filter(name => name.endsWith('.md'));
    
    for (const fileName of markdownFiles) {
      const content = await zip[fileName].async('text');
      const { frontmatter } = parseFrontmatter(content);

      // Extract title from frontmatter or filename
      const title = (frontmatter.title as string) || fileName.replace('.md', '').replace(/-/g, ' ');
      
      result.documents.push({
        id: `notion-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title,
        workspace: options.targetWorkspace || 'write',
      });
      result.imported++;
    }
  } catch (e) {
    result.errors.push(`Failed to import Notion export: ${e}`);
  }
  
  return result;
}

function readZip(file: File): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Dynamic import for JSZip (optional dependency)
        const JSZip = (await import('jszip')).default;
        if (JSZip) {
          const zip = await JSZip.loadAsync(e.target?.result);
          resolve(zip.files);
        } else {
          // Fallback: treat as single file
          const text = await file.text();
          resolve({ 'import.md': { async: () => text } });
        }
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

export async function importMarkdownFiles(files: File[], options: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [], documents: [] };
  
  for (const file of files) {
    try {
      const content = await file.text();
      const { frontmatter, body } = parseFrontmatter(content);
      
      const title = (frontmatter.title as string) || file.name.replace('.md', '').replace(/-/g, ' ');
      
      result.documents.push({
        id: `md-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title,
        workspace: options.targetWorkspace || 'write',
      });
      result.imported++;
    } catch (e) {
      result.errors.push(`Failed to import ${file.name}: ${e}`);
    }
  }
  
  return result;
}

export async function importFromJSON(jsonFile: File, options: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [], documents: [] };
  
  try {
    const content = await jsonFile.text();
    const data = JSON.parse(content);
    
    // Handle various JSON formats
    const docs = Array.isArray(data) ? data : data.documents || data.pages || data.notes || [];
    
    for (const doc of docs) {
      if (doc.title && (doc.content || doc.text || doc.body)) {
        result.documents.push({
          id: `json-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          title: doc.title,
          workspace: options.targetWorkspace || 'write',
        });
        result.imported++;
      }
    }
  } catch (e) {
    result.errors.push(`Failed to import JSON: ${e}`);
  }
  
  return result;
}

export async function batchExport(_docIds: string[], format: 'md' | 'txt' | 'html' | 'docx' | 'epub' | 'pdf' | 'zip', _options: { includeAttachments?: boolean; zipPassword?: string } = {}): Promise<{ filename: string; base64: string }> {
  // This would be implemented in the Rust backend
  // For now, return a placeholder
  return { filename: `export.${format}`, base64: '' };
}

export function generateSyncManifest(documents: any[]): string {
  return JSON.stringify({
    version: 1,
    exported: new Date().toISOString(),
    app: 'Just Write ehis',
    documents: documents.map(d => ({
      id: d.id,
      title: d.title,
      workspace: d.workspace,
      kind: d.kind,
      content: d.content,
      frontmatter: d.frontmatter_json,
      created_at: d.created_at,
      updated_at: d.updated_at,
      word_count: d.word_count,
      status: d.status,
      parent_id: d.parent_id,
    })),
  }, null, 2);
}

export async function parseSyncManifest(manifest: string): Promise<any[]> {
  const data = JSON.parse(manifest);
  return data.documents || [];
}