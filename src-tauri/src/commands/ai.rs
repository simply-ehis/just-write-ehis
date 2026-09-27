use tauri::State;
use crate::database::Database;
use crate::models::*;
use std::time::Duration;

fn resolve_slot(
    request: &AiGenerateRequest,
    db: &Database,
) -> Result<(String, String, String), String> {
    let settings = db.get_settings().map_err(|e| e.to_string())?;
    let slot = settings
        .aiSlots
        .get(request.slot.as_deref().unwrap_or("main"))
        .or_else(|| settings.aiSlots.values().next())
        .ok_or_else(|| "No AI slot configured".to_string())?;

    let endpoint = if slot.endpoint.is_empty() {
        "http://localhost:11434/v1".to_string()
    } else {
        slot.endpoint.clone()
    };
    let model = if slot.model.is_empty() {
        "llama3.2".to_string()
    } else {
        slot.model.clone()
    };
    let api_key = slot.apiKey.clone();

    Ok((endpoint, model, api_key))
}

fn authed_post(
    client: &reqwest::Client,
    endpoint: &str,
    body: &serde_json::Value,
    api_key: &str,
) -> Result<reqwest::Response, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(body);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }
    req.send().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_generate(
    db: State<'_, Database>,
    request: AiGenerateRequest,
) -> Result<String, String> {
    let (endpoint, model, api_key) = resolve_slot(&request, &db)?;
    let messages = vec![
        serde_json::json!({"role": "system", "content": request.system_prompt}),
        serde_json::json!({"role": "user", "content": request.prompt}),
    ];
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "stream": false,
    });

    let client = ai_http_client(90);
    let mut attempts = 0;
    let resp = loop {
        attempts += 1;
        let resp = authed_post(&client, &endpoint, &body, &api_key)
            .map_err(|e| format!("Failed to reach AI server: {}", e))?;
        let status = resp.status();
        if status.as_u16() == 429 || status.as_u16() == 503 {
            if attempts < 2 {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        }
        break resp;
    };

    let status = resp.status();
    if !status.is_success() {
        return Err(friendly_http_status(status.as_u16()));
    }

    let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    json["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid response from AI server".to_string())
}

#[tauri::command]
pub fn ai_generate_stream(
    db: State<'_, Database>,
    request: AiGenerateRequest,
    window: tauri::Window,
) -> Result<(), String> {
    let (endpoint, model, api_key) = resolve_slot(&request, &db)?;
    let messages = vec![
        serde_json::json!({"role": "system", "content": request.system_prompt}),
        serde_json::json!({"role": "user", "content": request.prompt}),
    ];
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "stream": true,
    });

    let client = ai_http_client(120);
    let mut attempts = 0;
    let mut resp = loop {
        attempts += 1;
        let resp = authed_post(&client, &endpoint, &body, &api_key)
            .map_err(|e| format!("Failed to reach AI server: {}", e))?;
        let status = resp.status();
        if status.as_u16() == 429 || status.as_u16() == 503 {
            if attempts < 2 {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        }
        break resp;
    };

    let status = resp.status();
    if !status.is_success() {
        return Err(friendly_http_status(status.as_u16()));
    }

    use std::io::Read;
    let mut stream = resp;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    return Ok(());
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        let _ = window.emit("ai-stream-chunk", content.to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ai_structurize(
    db: State<'_, Database>,
    request: AiGenerateRequest,
) -> Result<String, String> {
    let (endpoint, model, api_key) = resolve_slot(&request, &db)?;
    let messages = vec![
        serde_json::json!({"role": "system", "content": request.system_prompt}),
        serde_json::json!({"role": "user", "content": request.prompt}),
    ];
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "stream": false,
    });

    let client = ai_http_client(180);
    let mut attempts = 0;
    let resp = loop {
        attempts += 1;
        let resp = authed_post(&client, &endpoint, &body, &api_key)
            .map_err(|e| format!("Failed to reach AI server: {}", e))?;
        let status = resp.status();
        if status.as_u16() == 429 || status.as_u16() == 503 {
            if attempts < 2 {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        }
        break resp;
    };

    let status = resp.status();
    if !status.is_success() {
        return Err(friendly_http_status(status.as_u16()));
    }

    let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    json["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid response from AI server".to_string())
}
