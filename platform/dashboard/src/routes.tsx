import { lazy, Suspense, type ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Boot, Home, ProjectLink, ProjectShell, RequireAuth } from "./components/Shell.tsx";
import { ConfirmHost, Toaster } from "./components/ui.tsx";

// Declarative routes keep the router small; pages load on demand. Navigations run in a transition, so the
// current page stays on screen until the next one has loaded instead of flashing a fallback.
const page = (load: () => Promise<{ default: ComponentType }>) => {
  const C = lazy(load);
  return <C />;
};

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Boot />}>
        <Routes>
          <Route path="/signin" element={page(() => import("./pages/SignIn.tsx"))} />
          <Route path="/signin/check" element={page(() => import("./pages/CheckEmail.tsx"))} />
          <Route path="/sign-in" element={<Navigate to="/signin" replace />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Home />} />
            <Route path="/device" element={page(() => import("./pages/Device.tsx"))} />
            <Route path="/projects/:project/*" element={<ProjectLink />} />
            <Route path="/p/:project/:env" element={<ProjectShell />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={page(() => import("./pages/Overview.tsx"))} />
              <Route path="payments" element={page(() => import("./pages/Payments.tsx"))} />
              <Route path="payments/:attempt" element={page(() => import("./pages/PaymentDetail.tsx"))} />
              <Route path="live" element={page(() => import("./pages/Live.tsx"))} />
              <Route path="analytics" element={page(() => import("./pages/Analytics.tsx"))} />
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
