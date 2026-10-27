import argparse
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
OUTPUT = ROOT / "bin"
VENV = ROOT / ".runtime-build-venv"
REQUIRED_ASSETS = (
    ROOT / "models" / "moonshine-base-Q8_0.gguf",
    # Dir name == model registry key (see modelRegistry.ts / fetch_sidecars.py).
    ROOT / "models" / "phonon-31m-en" / "model.q8.gguf",
    ROOT / "models" / "phonon-31m-en" / "config.json",
    ROOT / "models" / "phonon-31m-en" / "tokenizer.json",
    ROOT / "models" / "phonon-31m-en" / "default-voice.safetensors",
    ROOT / "models" / "phonon-31m-en" / "voices.jsonl",
    # The LLM is deliberately NOT bundled: no llama.cpp runner, no ggml DLLs
    # and no chat GGUF ship in the installer. Local completion is
    # bring-your-own (fetch_sidecars.py --llm plus a GGUF in
    # Documents/Just Write ehis/models, see docs/MODELS.md); everyone else
    # uses an HTTP provider from Settings -> AI & Providers.
)


def run(command: list[str], cwd: Path = REPO) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def validate_assets() -> None:
    if os.name != "nt":
        raise SystemExit("Native sidecars currently support Windows packaging only.")
    missing = [str(path) for path in REQUIRED_ASSETS if not path.exists()]
    phonon_dir = ROOT / "models" / "phonon-31m-en"
    if not (phonon_dir / "voices.jsonl").is_file():
        missing.append(str(phonon_dir / "voices.jsonl"))
    voices_dir = phonon_dir / "voices"
    if not voices_dir.is_dir() or not any(voices_dir.glob("*.safetensors")):
        missing.append(str(voices_dir / "*.safetensors"))
    if missing:
        raise SystemExit(
            "Missing release assets: "
            + ", ".join(missing)
            + ". Run fetch_sidecars.py --stt --phonon --typst, then retry."
        )


def ensure_python() -> None:
    validate_assets()
    if not VENV.exists():
        venv.EnvBuilder(with_pip=True).create(VENV)
    python = VENV / "Scripts" / "python.exe"
    run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "-r", str(ROOT / "requirements.txt"), "pyinstaller==6.22.2",
    ], ROOT)


def build_one(python: Path, name: str, script: Path, extra: list[str]) -> None:
    dist = ROOT / ".runtime-build-dist" / name
    work = ROOT / ".runtime-build-work" / name
    dist.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    run([
        str(python), "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name", name,
        "--distpath", str(dist),
        "--workpath", str(work),
        "--specpath", str(work),
        *extra,
        str(script),
    ], ROOT)
    built = dist / f"{name}.exe"
    if not built.is_file():
        raise RuntimeError(f"PyInstaller did not create {built}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    shutil.copy2(built, OUTPUT / built.name)


def build_rust_sidecar(name: str) -> None:
    """Build a Rust sidecar crate with cargo --release and copy the exe to OUTPUT."""
    crate_dir = ROOT / name
    if not crate_dir.is_dir():
        raise RuntimeError(f"Rust sidecar crate not found: {crate_dir}")
    run(["cargo", "build", "--release"], crate_dir)
    built = crate_dir / "target" / "release" / f"{name}.exe"
    if not built.is_file():
        raise RuntimeError(f"cargo build --release did not create {built}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    shutil.copy2(built, OUTPUT / built.name)
    print(f"[build] Rust sidecar ready: {OUTPUT / built.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        validate_assets()
        print("Native sidecar asset preflight passed")
        return
    ensure_python()
    python = VENV / "Scripts" / "python.exe"
    build_one(
        python,
        "stt-server",
        ROOT / "stt_server.py",
        [
            "--collect-all", "transcribe_cpp",
            "--collect-all", "transcribe_cpp_native",
            "--copy-metadata", "transcribe_cpp",
            "--copy-metadata", "transcribe_cpp_native",
        ],
    )
    build_rust_sidecar("phonon-server")
    build_one(python, "memory-server", ROOT / "memory_server.py", ["--add-data", f"{ROOT / 'harness'}{os.pathsep}harness"])
    print(f"Native sidecars ready in {OUTPUT}")


if __name__ == "__main__":
    main()
