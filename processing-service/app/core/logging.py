"""Logging setup. Request bodies and headers are never logged."""

import logging


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    # httpx/httpcore log every request URL at INFO. Signed storage URLs carry
    # credentials in their query string, so keep these loggers quiet.
    for noisy in ("httpx", "httpcore", "google_genai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
