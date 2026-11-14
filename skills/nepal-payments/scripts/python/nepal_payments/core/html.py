"""Turn a FormResult into a page that posts itself to the provider."""

from __future__ import annotations

from html import escape

from .types import FormResult


def render_auto_submit_form(r: FormResult) -> str:
    """A minimal HTML page that auto-submits `r` (with a no-JS fallback button)."""
    inputs = "".join(_hidden_input(name, value) for name, value in r.fields.items())
    enctype = f' enctype="{_attr(r.enctype)}"' if r.enctype else ""
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Redirecting to payment…</title>"
        f'</head><body><form id="f" method="POST" action="{_attr(r.action)}"{enctype}>'
        f"{inputs}"
        '<noscript><button type="submit">Continue to payment</button></noscript></form>'
        '<script>document.getElementById("f").submit()</script></body></html>'
    )


def _hidden_input(name: str, value: object) -> str:
    return f'<input type="hidden" name="{_attr(name)}" value="{_attr(str(value))}">'


def _attr(value: str) -> str:
    return escape(value, quote=True)
