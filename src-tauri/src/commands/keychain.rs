use tauri::State;
use crate::database::Database;
use crate::models::*;
use super::{constant_time_eq, verify_pin_value};

#[tauri::command]
pub fn secret_set(
    db: State<'_, Database>,
    key: String,
    value: String,
) -> Result<(), String> {
    db.set_secret(&key, &value)
}

#[tauri::command]
pub fn secret_get(db: State<'_, Database>, key: String) -> Result<Option<String>, String> {
    db.get_secret(&key)
}

#[tauri::command]
pub fn app_lock_configured(db: State<'_, Database>) -> Result<bool, String> {
    db.is_pin_configured()
}

#[tauri::command]
pub fn app_lock_verify(
    db: State<'_, Database>,
    pin: String,
) -> Result<bool, String> {
    let stored = db.get_secret("app_pin")?;
    match stored {
        Some(stored_pin) => Ok(verify_pin_value(&stored_pin, &pin)),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn app_lock_reset(db: State<'_, Database>) -> Result<(), String> {
    db.remove_secret("app_pin")
}
