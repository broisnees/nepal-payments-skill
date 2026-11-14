/**
 * The four browser pages GetPay's SDK flow needs. Values interpolated into inline scripts go
 * through scriptJson() so a "</script>" inside them cannot end the script early.
 */
import { escapeHtml, pageHead, scriptJson } from "../../core/html.ts";
import type { SdkResult } from "../../core/types.ts";

/** Page 1: loads the bundle and starts checkout; onSuccess opens `paymentPageUrl`. */
export function checkoutPage(r: SdkResult, paymentPageUrl: string): string {
  const script = [
    `window.addEventListener("load",function(){`,
    `var o=${scriptJson(r.options)};`,
    `o.onSuccess=function(){location.href=${scriptJson(paymentPageUrl)}};`,
    `o.onError=function(e){document.body.insertAdjacentHTML("beforeend",`,
    `"<p>Card checkout could not start. Please try again.</p>");console.error(e)};`,
    `new GetPay(o).initialize()});`,
  ].join("");
  return [
    pageHead("Checkout"),
    `\n<script defer src="${escapeHtml(r.scriptUrl)}"></script></head><body>`,
    `<div id="checkout" hidden></div>`,
    `<noscript>JavaScript is required to pay by card.</noscript>`,
    `\n<script>${script}</script></body></html>`,
  ].join("");
}

/** Page 2: GetPay renders the card form into #checkout. */
export function paymentPage(bundleUrl: string): string {
  return [
    pageHead("Pay by card"),
    `\n<script defer src="${escapeHtml(bundleUrl)}"></script></head><body>`,
    `<div id="checkout"></div></body></html>`,
  ].join("");
}

/**
 * Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from the
 * query or the #hash, and send it to `verifyUrl` as ?token=.
 */
export function returnPage(verifyUrl: string): string {
  const script = [
    `if(window.top!==window.self){window.top.location=window.self.location.href}`,
    `else{var h=location.hash||"",q=new URLSearchParams(location.search);`,
    `var t=q.get("token")||new URLSearchParams(`,
    `h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");`,
    `var u=new URL(${scriptJson(verifyUrl)},location.href);`,
    `if(t)u.searchParams.set("token",t);location.replace(u.toString())}`,
  ].join("");
  return [
    pageHead("Confirming payment", false),
    `</head><body><p>Confirming your payment...</p>`,
    `\n<script>${script}</script></body></html>`,
  ].join("");
}
