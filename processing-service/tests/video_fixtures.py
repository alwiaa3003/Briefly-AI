"""Shared data and helpers for video tests."""

import subprocess
from pathlib import Path

from app.core.config import get_settings
from app.media.ffmpeg import ffmpeg_executable
from app.schemas.videos import TranscriptSegment

ENCODERS = {
    "mp4": ["-c:v", "libx264", "-c:a", "aac"],
    "mov": ["-c:v", "libx264", "-c:a", "aac"],
    "mkv": ["-c:v", "libx264", "-c:a", "aac"],
    "webm": ["-c:v", "libvpx-vp9", "-c:a", "libopus"],
}


def make_video(directory: Path, container: str = "mp4", seconds: int = 4, audio: bool = True) -> Path:
    """Generates a tiny real video (grey frames + a sine tone) with the bundled ffmpeg."""
    path = directory / f"sample.{container}"
    args = [ffmpeg_executable(get_settings()), "-hide_banner", "-loglevel", "error", "-y"]
    args += ["-f", "lavfi", "-i", f"color=c=gray:s=64x64:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    codecs = ENCODERS[container] if audio else ENCODERS[container][:2]
    args += [*codecs, "-shortest", str(path)]
    subprocess.run(args, check=True, capture_output=True)
    return path


SEGMENTS = [
    TranscriptSegment(start=0.0, end=12.5, text="Welcome. Today we look at how urban trees cool cities.", speaker="Speaker 1"),
    TranscriptSegment(start=12.5, end=40.0, text="Trees cool streets through shade and evapotranspiration."),
    TranscriptSegment(start=40.0, end=95.0, text="Lower-income districts have far less canopy than wealthy ones."),
    TranscriptSegment(start=95.0, end=150.0, text="Young trees take a decade to provide meaningful cooling."),
    TranscriptSegment(start=150.0, end=180.0, text="So cities must protect mature trees and fund maintenance."),
]

VALID_VIDEO_SUMMARY = {
    "title": "How Urban Trees Cool Cities",
    "overview": "The speaker explains how trees cool streets and why the benefit is unevenly shared between districts.",
    "sections": [
        {"heading": "How trees cool streets", "content": "Shade and evapotranspiration lower temperatures."},
        {"heading": "Unequal canopy", "content": "Lower-income districts have far less canopy cover."},
    ],
    "key_takeaways": [
        "Trees cool streets through shade.",
        "Evapotranspiration also lowers air temperature.",
        "Canopy is unequally distributed.",
        "Young trees need about a decade.",
        "Mature trees must be protected.",
    ],
    "concepts": [{"term": "Evapotranspiration", "explanation": "Water released by leaves that cools the air."}],
    "main_arguments": ["Cities should protect mature trees and fund maintenance."],
    "chapters": [
        {"title": "Introduction", "start_seconds": 0, "summary": "The topic of urban cooling is introduced."},
        {"title": "Why trees cool", "start_seconds": 13, "summary": "Shade and evapotranspiration."},
        {"title": "Inequality", "start_seconds": 40, "summary": "Canopy differs between districts."},
        {"title": "What cities should do", "start_seconds": 150, "summary": "Protect and maintain trees."},
    ],
    "key_moments": [
        {"seconds": 41, "description": "Canopy inequality is described"},
        {"seconds": 150, "description": "The main recommendation"},
    ],
}
