//! phonon-server.exe — Rust TTS sidecar for Just Write ehis.
//!
//! Speaks the same JSON-lines stdio protocol as the old Kokoro sidecar:
//! request `{"id","method","params"}` → response `{"id","ok","result|error"}`.
//! Methods: `health`, `synthesize`, `stop`.
//!
//! The model directory is argv[1] when provided, otherwise
//! `$JWE_SIDECARS_DIR/models/phonon`. Voices live beside the model and are
//! auto-registered at startup.

use std::env;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use base64::engine::{general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::json;

mod engine;
mod protocol;
mod voices;

use engine::{pcm_to_wav_bytes, TtsEngine};
use protocol::{HealthResult, Request, Response, SynthesizeResult, StreamChunkResult, StreamStartResult};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Boot guard — same contract as the Python sidecars (stt_server.py):
    // the stdio pipe is private to the parent, but refusing to start
    // without the launcher's token keeps old/new builds interchangeable.
    if env::var("JWE_SIDECAR_TOKEN").map(|t| t.trim().is_empty()).unwrap_or(true) {
        return Err("JWE_SIDECAR_TOKEN is required".into());
    }

    let args: Vec<String> = env::args().collect();

    // Model directory: argv[1] when provided, otherwise $JWE_SIDECARS_DIR/models/phonon
    let model_dir = if args.len() > 1 {
        PathBuf::from(&args[1])
    } else {
        let sidecars_dir = env::var("JWE_SIDECARS_DIR")
            .unwrap_or_else(|_| std::env::current_dir().unwrap().to_string_lossy().to_string());
        PathBuf::from(sidecars_dir).join("models").join("phonon")
    };

    let model_dir = model_dir.canonicalize().unwrap_or_else(|_| model_dir.clone());

    eprintln!("[phonon] loading model from {}", model_dir.display());
    let engine = engine::TtsEngine::load(&model_dir)?;
    voices::register_all(&engine, &model_dir)?;

    let default_voice = voices::default_voice_name(&engine);
    eprintln!(
        "[phonon] ready: sample_rate={} voices={} default={:?}",
        engine.sample_rate(),
        engine.voices().len(),
        default_voice
    );

    let mut stdin = std::io::BufReader::new(std::io::stdin().lock());
    let mut stdout = std::io::stdout().lock();

    // Announce readiness so the frontend can poll health immediately.
    let ready = Response::ok(0, json!({"status": "ready"}));
    writeln!(stdout, "{}", serde_json::to_string(&ready)?)?;
    stdout.flush()?;

    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => {
                eprintln!("[phonon] stdin read error: {e}");
                break;
            }
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::err(0, format!("invalid JSON: {e}"));
                let _ = writeln!(stdout, "{}", serde_json::to_string(&resp)?);
                let _ = stdout.flush();
                continue;
            }
        };

        let response = handle_request(&engine, &request);
        let _ = writeln!(stdout, "{}", serde_json::to_string(&response)?);
        let _ = stdout.flush();
    }

    Ok(())
}

fn handle_request(engine: &TtsEngine, request: &Request) -> protocol::Response {
    match request.method.as_str() {
        "health" => {
            let ready = engine.is_ready();
            let health = HealthResult {
                status: if ready { "ok" } else { "error" }.to_string(),
                ready,
                model_loaded: ready,
                sample_rate: engine.sample_rate(),
                default_voice: engine
                    .default_voice_name()
                    .or_else(|| voices::default_voice_name(engine)),
                voices: engine.voice_names(),
                error: if ready { None } else { Some("model not loaded".to_string()) },
            };
            Response::ok(request.id, health.to_value())
        }
        "synthesize" => {
            let text = request.param_str("text").unwrap_or_default();
            if text.trim().is_empty() {
                return Response::err(request.id, "empty text".to_string());
            }
            let voice = request.param_str("voice");
            let _speed = request.param_f64("speed").unwrap_or(1.0);
            match engine.synthesize(&text, voice.as_deref(), 1.0) {
                Ok((audio_b64, sample_rate)) => {
                    let result = SynthesizeResult {
                        audio_b64,
                        sample_rate,
                        voice_fallback: None,
                    };
                    Response::ok(request.id, result.to_value())
                }
                Err(e) => Response::err(request.id, format!("synthesis failed: {e}")),
            }
        }
        "stream_start" => {
            let text = request.param_str("text").unwrap_or_default();
            if text.trim().is_empty() {
                return Response::err(request.id, "empty text".to_string());
            }
            let voice = request.param_str("voice");
            match engine.stream_start(&text, voice.as_deref()) {
                Ok((stream_id, sample_rate)) => {
                    let result = StreamStartResult { stream_id, sample_rate };
                    Response::ok(request.id, result.to_value())
                }
                Err(e) => Response::err(request.id, format!("stream start failed: {e}")),
            }
        }
        "stream_chunk" => {
            let stream_id = match request.param_str("stream_id")
                .and_then(|s| s.parse::<u64>().ok())
            {
                Some(id) => id,
                None => return Response::err(request.id, "missing stream_id".to_string()),
            };
            match engine.stream_chunk(stream_id) {
                Ok(Ok(Some(pcm))) => {
                    let wav_bytes = pcm_to_wav_bytes(&pcm, engine.sample_rate()).unwrap_or_default();
                    let audio_b64 = BASE64.encode(&wav_bytes);
                    let result = StreamChunkResult {
                        audio_b64: Some(audio_b64),
                        sample_rate: engine.sample_rate(),
                        done: false,
                    };
                    Response::ok(request.id, result.to_value())
                }
                Ok(Ok(None)) => {
                    let result = StreamChunkResult {
                        audio_b64: None,
                        sample_rate: engine.sample_rate(),
                        done: true,
                    };
                    Response::ok(request.id, result.to_value())
                }
                Ok(Err(e)) => Response::err(request.id, format!("stream chunk failed: {e}")),
                Err(e) => Response::err(request.id, format!("stream error: {e}")),
            }
        }
        "stream_stop" => {
            let stream_id = match request.param_str("stream_id")
                .and_then(|s| s.parse::<u64>().ok())
            {
                Some(id) => id,
                None => return Response::err(request.id, "missing stream_id".to_string()),
            };
            match engine.stream_stop(stream_id) {
                Ok(()) => Response::ok(request.id, json!({"status": "stopped"})),
                Err(e) => Response::err(request.id, format!("stream stop failed: {e}")),
            }
        }
        "stop" => Response::ok(request.id, json!({"status": "stopped"})),
        _ => Response::err(request.id, format!("unknown method: {}", request.method)),
    }
}
