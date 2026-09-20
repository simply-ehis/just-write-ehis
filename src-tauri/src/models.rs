use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    pub workspace: String,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub content: String,
    pub word_count: i64,
    pub reading_position: Option<f64>,
    pub status: String,
    pub frontmatter_json: Option<String>,
    pub activity_score: f64,
    pub embedding_ref: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub goal_words: Option<i64>,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backlink {
    pub source_id: String,
    pub target_id: String,
    pub context_snippet: String,
}

// ── Implicit links (auto-detected mentions) ─────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkImplicit {
    pub source_id: String,
    pub target_id: String,
    pub match_type: String,
}

// ── Usage tracking ──────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEvent {
    pub doc_id: String,
    pub event: String,
    pub ts: String,
}

// ── Craft / writing metrics ─────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CraftMetric {
    pub id: String,
    pub doc_id: String,
    pub metric_type: String,
    pub value: f64,
    pub created_at: String,
}

// ── Reader position sync ────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateReadingPositionRequest {
    pub doc_id: String,
    pub position: f64,
}

// ── File import ─────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportFileRequest {
    pub file_path: String,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabState {
    pub workspace: String,
    pub tab_stack_json: String,
    pub active_id: Option<String>,
    pub cursor: Option<String>,
    pub scroll: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub doc_id: Option<String>,
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BibleFact {
    pub id: String,
    pub doc_id: String,
    pub kind: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDocRequest {
    pub workspace: String,
    pub kind: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub content: Option<String>,
    pub frontmatter_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveDocRequest {
    pub id: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub status: Option<String>,
    pub frontmatter_json: Option<String>,
    pub parent_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveDocRequest {
    pub id: String,
    pub new_parent_id: Option<String>,
    pub new_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub doc: Doc,
    pub rank: f64,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub kind: String,
    pub word_count: i64,
    pub activity_score: f64,
    pub degree: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub context_snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphQueryResult {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub orphans: Vec<String>,
    pub hubs: Vec<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlinkedMention {
    pub source_id: String,
    pub source_title: String,
    pub mentioned_title: String,
    pub context_snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookshelfEntry {
    pub doc: Doc,
    pub shelf_status: String,
    pub rating: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatNode {
    pub doc: Doc,
    pub act: Option<i64>,
    pub sequence: Option<i64>,
    pub status: String,
    pub summary: Option<String>,
    pub pov: Option<String>,
    pub location: Option<String>,
    pub timeframe: Option<String>,
    pub characters: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatBoard {
    pub acts: Vec<BeatNode>,
    pub sequences: Vec<BeatNode>,
    pub scenes: Vec<BeatNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiGenerateRequest {
    pub prompt: String,
    pub system_prompt: Option<String>,
    pub mode: String,
    pub workspace: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub max_tokens: Option<u32>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiGenerateResponse {
    pub content: String,
    pub tokens_used: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructurizeRequest {
    pub text: String,
    pub workspace: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructurizeResponse {
    pub result: String,
    pub tokens_used: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub doc_id: String,
    pub label: String,
    pub content: Option<String>,
    pub word_count: i64,
    pub content_hash: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasNode {
    pub id: String,
    pub title: String,
    pub body: String,
    pub x: f64,
    pub y: f64,
    pub color: String,
    pub doc_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasEdge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagChunk {
    pub id: String,
    pub doc_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub start_word: usize,
    pub end_word: usize,
}

// ── Ghosts (scene forking) ──────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhostGroup {
    pub original: Doc,
    pub ghosts: Vec<Doc>,
}

// ── Atlas (star-sky memory) ─────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtlasStar {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub word_count: i64,
    pub activity_score: f64,
    pub updated_at: String,
    pub embedding: Vec<f32>,
}
