use tauri::State;
use crate::models::*;
use crate::sidecar;

#[tauri::command]
pub fn stt_start() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn stt_stop() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn stt_is_running() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn stt_health() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn stt_port() -> Result<u16, String> {
    Ok(8090)
}

#[tauri::command]
pub fn stt_transcribe(path: String) -> Result<String, String> {
    let _ = path;
    Ok(String::new())
}

#[tauri::command]
pub fn stt_stream_start() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn stt_stream_chunk() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn stt_stream_stop() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn tts_start() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn tts_stop() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn tts_is_running() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn tts_health() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn tts_port() -> Result<u16, String> {
    Ok(8091)
}

#[tauri::command]
pub fn tts_synthesize(text: String) -> Result<(), String> {
    let _ = text;
    Ok(())
}

#[tauri::command]
pub fn tts_stop_playback() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn llm_start() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn llm_stop() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn llm_is_running() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn llm_health() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn llm_port() -> Result<u16, String> {
    Ok(8093)
}

#[tauri::command]
pub fn llm_completion(prompt: String) -> Result<String, String> {
    let _ = prompt;
    Ok(String::new())
}

#[tauri::command]
pub fn llm_chat_completion(messages: Vec<serde_json::Value>) -> Result<String, String> {
    let _ = messages;
    Ok(String::new())
}
