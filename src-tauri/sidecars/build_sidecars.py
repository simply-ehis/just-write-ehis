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
    ROOT / "models" / "kokoro-multi-lang-v1_0" / "voices.bin",
    ROOT / "models" / "kokoro-multi-lang-v1_0" / "tokens.txt",
    ROOT / "models" / "kokoro-multi-lang-v1_0" / "espeak-ng-data",
    ROOT / "models" / "llama-server.exe",
    ROOT / "models" / "llama.dll",
    ROOT / "models" / "llama-server-impl.dll",
    ROOT / "models" / "ggml.dll",
    ROOT / "models" / "ggml-cpu.dll",
    ROOT / "models" / "lfm2.5-350m-q4_k_m.gguf",
)


def run(command: list[str], cwd: Path = REPO) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def validate_assets() -> None:
    if os.name != "nt":
        raise SystemExit("Native sidecars currently support Windows packaging only.")
    missing = [str(path) for path in REQUIRED_ASSETS if not path.exists()]
    tts_dir = ROOT / "models" / "kokoro-multi-lang-v1_0"
    if not (tts_dir / "model.int8.onnx").is_file() and not (tts_dir / "model.onnx").is_file():
        missing.append(str(tts_dir / "model.int8.onnx or model.onnx"))
    if missing:
        raise SystemExit(
            "Missing release assets: "
            + ", ".join(missing)
            + ". Run fetch_sidecars.py --stt --tts --llm, then retry."
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
    build_one(python, "tts-server", ROOT / "tts_server.py", ["--collect-all", "sherpa_onnx"])
    build_one(python, "memory-server", ROOT / "memory_server.py", ["--add-data", f"{ROOT / 'harness'}{os.pathsep}harness"])
    print(f"Native sidecars ready in {OUTPUT}")


if __name__ == "__main__":
    main()
