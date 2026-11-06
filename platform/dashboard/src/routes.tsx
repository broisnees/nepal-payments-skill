import { lazy, Suspense, type ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Boot, Home, ProjectLink, ProjectShell, RequireAuth } from "./components/Shell.tsx";
import { ConfirmHost, Toaster } from "./components/ui.tsx";

// Declarative routes keep the router small; pages load on demand. Navigations run in a transition, so the
// current page stays on screen until the next one has loaded instead of flashing a fallback.
const loaders: (() => Promise<unknown>)[] = [];
const page = (load: () => Promise<{ default: ComponentType }>) => {
  loaders.push(load);
  const C = lazy(load);
  return <C />;
};

/**
 * After the first page is on screen, fetch every other page's chunk while the browser is idle, so later
 * navigation never waits on the network. Skipped when the visitor asked to save data.
 */
function prefetchPages() {
  const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
  idle(() => {
    for (const load of loaders) void load().catch(() => {});
  });
}
if (typeof window !== "undefined") window.addEventListener("load", prefetchPages, { once: true });

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Boot />}>
        <Routes>
          <Route path="/signin" element={page(() => import("./pages/SignIn.tsx"))} />
          <Route path="/signin/check" element={page(() => import("./pages/CheckEmail.tsx"))} />
          <Route path="/sign-in" element={<Navigate to="/signin" replace />} />
          <Route path="/signup" element={page(() => import("./pages/SignUp.tsx"))} />
          <Route path="/sign-up" element={<Navigate to="/signup" replace />} />
          <Route path="/docs/:slug?" element={page(() => import("./public/docs/Docs.tsx"))} />
          {/* Signed in: "/" goes to the last project as before. Signed out: the landing page. */}
          <Route element={<RequireAuth fallback={page(() => import("./public/Landing.tsx"))} />}>
            <Route path="/" element={<Home />} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route path="/device" element={page(() => import("./pages/Device.tsx"))} />
            <Route path="/projects/:project/*" element={<ProjectLink />} />
            <Route path="/p/:project/:env" element={<ProjectShell />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={page(() => import("./pages/Overview.tsx"))} />
              <Route path="payments" element={page(() => import("./pages/Payments.tsx"))} />
              <Route path="payments/:attempt" element={page(() => import("./pages/PaymentDetail.tsx"))} />
              <Route path="live" element={page(() => import("./pages/Live.tsx"))} />
              <Route path="analytics" element={page(() => import("./pages/Analytics.tsx"))} />
              <Route path="ask" element={page(() => import("./pages/Ask.tsx"))} />
              <Route path="support" element={page(() => import("./pages/Support.tsx"))} />
              <Route path="refunds" element={page(() => import("./pages/Refunds.tsx"))} />
              <Route path="reconcile" element={page(() => import("./pages/Reconcile.tsx"))} />
              <Route path="exports" element={page(() => import("./pages/Exports.tsx"))} />
              <Route path="go-live" element={page(() => import("./pages/GoLive.tsx"))} />
              <Route path="alerts" element={<Navigate to="rules" replace />} />
              <Route path="alerts/:tab" element={page(() => import("./pages/Alerts.tsx"))} />
              <Route path="settings" element={<Navigate to="general" replace />} />
              <Route path="settings/:section" element={page(() => import("./pages/Settings.tsx"))} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
      <ConfirmHost />
    </BrowserRouter>
  );
}
