pub mod ai;
pub mod bible;
pub mod dashboard;
pub mod doc;
pub mod fs;
pub mod keychain;
pub mod memory;
pub mod misc;
pub mod publish;
pub mod script;
pub mod sidecar;
pub mod widget;

use std::sync::Mutex;
use crate::database::Database;
use tauri::Manager;

#[derive(Default)]
pub struct PinLockout {
    pub attempts: Mutex<u32>,
    pub locked_until: Mutex<Option<std::time::Instant>>,
}

impl PinLockout {
    pub fn record_failure(&self) -> u32 {
        let mut attempts = self.attempts.lock().unwrap();
        *attempts += 1;
        if *attempts >= 5 {
            let mut locked = self.locked_until.lock().unwrap();
            *locked = Some(std::time::Instant::now() + std::time::Duration::from_secs(30));
            *attempts = 0;
        }
        *attempts
    }

    pub fn is_locked(&self) -> Option<std::time::Duration> {
        let locked = self.locked_until.lock().unwrap();
        match *locked {
            Some(until) => {
                let now = std::time::Instant::now();
                if now < until {
                    Some(until - now)
                } else {
                    None
                }
            }
            None => None,
        }
    }

    pub fn reset(&self) {
        let mut attempts = self.attempts.lock().unwrap();
        let mut locked = self.locked_until.lock().unwrap();
        *attempts = 0;
        *locked = None;
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        result |= x ^ y;
    }
    result == 0
}

fn verify_pin_value(stored: &str, provided: &str) -> bool {
    constant_time_eq(stored.trim(), provided.trim())
}

fn friendly_http_status(status: u16) -> String {
    match status {
        401 => "Authentication failed — check your API key".into(),
        403 => "Access forbidden — check your API key permissions".into(),
        429 => "Rate limited — wait a moment and try again".into(),
        408 => "Request timed out — the server took too long".into(),
        503 => "Service unavailable — the AI provider is down".into(),
        _ => format!("HTTP error {}", status),
    }
}

fn ai_http_client(timeout_secs: u64) -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .expect("failed to build AI HTTP client")
    }).clone()
}
