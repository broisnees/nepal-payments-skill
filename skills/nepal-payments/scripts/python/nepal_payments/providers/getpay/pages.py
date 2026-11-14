"""The browser pages GetPay's SDK flow needs (served by your app; see README.md)."""

from __future__ import annotations

import html
import json
from typing import Any, Mapping


def script_json(value: Any) -> str:
    """JSON safe to embed inside <script>.

    "<" becomes \\u003c so "</script>" cannot close the tag.
    """
    return json.dumps(value).replace("<", "\\u003c")


def checkout_page_html(script_url: str, options: Mapping[str, Any], payment_page_url: str) -> str:
    """Page 1: loads the bundle and starts checkout; onSuccess opens `payment_page_url`."""
    return (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
        'content="width=device-width,initial-scale=1"><title>Checkout</title>\n'
        f'<script defer src="{html.escape(script_url)}"></script></head><body>'
        '<div id="checkout" hidden></div>'
        "<noscript>JavaScript is required to pay by card.</noscript>\n"
        '<script>window.addEventListener("load",function(){'
        f"var o={script_json(options)};"
        f"o.onSuccess=function(){{location.href={script_json(payment_page_url)}}};"
        'o.onError=function(e){document.body.insertAdjacentHTML("beforeend",'
        '"<p>Card checkout could not start. Please try again.</p>");console.error(e)};'
        "new GetPay(o).initialize()});</script></body></html>"
    )


def payment_page_html(bundle_url: str) -> str:
    """Page 2: GetPay renders the card form into #checkout."""
    return (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
        'content="width=device-width,initial-scale=1"><title>Pay by card</title>\n'
        f'<script defer src="{html.escape(bundle_url)}"></script></head><body>'
        '<div id="checkout"></div></body></html>'
    )


def return_page_html(verify_url: str) -> str:
    """Pages 3 and 4 (success and fail URLs).

    Break out of GetPay's iframe, read the token from the query or the #hash, and send it to
    `verify_url` as ?token=.
    """
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Confirming payment</title>'
        "</head><body><p>Confirming your payment...</p>\n"
        "<script>if(window.top!==window.self){window.top.location=window.self.location.href}"
        'else{var h=location.hash||"",q=new URLSearchParams(location.search);'
        'var t=q.get("token")||new URLSearchParams('
        'h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");'
        f"var u=new URL({script_json(verify_url)},location.href);"
        'if(t)u.searchParams.set("token",t);'
        "location.replace(u.toString())}</script></body></html>"
    )
